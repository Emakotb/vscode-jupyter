// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject, named } from 'inversify';
import { IDisposable, IDisposableRegistry, IMemento, WORKSPACE_MEMENTO } from '../../platform/common/types';
import { Disposables } from '../../platform/common/utils';
import { IKernel, ResumeCellExecutionInformation, isRemoteConnection } from '../types';
import type { KernelMessage } from '@jupyterlab/services';
import { IAnyMessageArgs } from '@jupyterlab/services/lib/kernel/kernel';
import { disposeAllDisposables } from '../../platform/common/helpers';
import { Disposable, Memento, NotebookCell, NotebookDocument } from 'vscode';
import { noop, swallowExceptions } from '../../platform/common/utils/misc';
import { getParentHeaderMsgId } from './cellExecutionMessageHandler';
import { IJupyterServerUriEntry, IJupyterServerUriStorage } from '../jupyter/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';

type CellExecutionInfo = Omit<ResumeCellExecutionInformation, 'token'> & { kernelId: string; cellIndex: number };
/**
 * Keeps track of the last cell that was executed for a notebook along with the time and execution count.
 */
@injectable()
export class LastCellExecutionTracker extends Disposables implements IExtensionSyncActivationService {
    private readonly executedCells = new WeakMap<NotebookCell, Partial<CellExecutionInfo>>();
    private chainedPromises = Promise.resolve();
    constructor(
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @named(WORKSPACE_MEMENTO) @inject(IMemento) private readonly workspaceMemento: Memento,
        @inject(IJupyterServerUriStorage) private readonly serverStorage: IJupyterServerUriStorage
    ) {
        super();
        disposables.push(this);
    }
    public activate(): void {
        this.serverStorage.onDidRemove(this.onDidRemoveServerUris, this, this.disposables);
    }
    private getStateKey(serverId: string) {
        return `LAST_EXECUTED_CELL_${serverId}`;
    }
    public getLastTrackedCellExecution(notebook: NotebookDocument, kernel: IKernel): CellExecutionInfo | undefined {
        if (notebook.isUntitled) {
            return;
        }
        if (!isRemoteConnection(kernel.kernelConnectionMetadata)) {
            return;
        }
        const data = this.workspaceMemento.get<{ [key: string]: CellExecutionInfo }>(
            this.getStateKey(kernel.kernelConnectionMetadata.serverId),
            {}
        );
        return data[notebook.uri.toString()];
    }
    public trackCellExecution(cell: NotebookCell, kernel: IKernel) {
        // For now we are only interested in remote kernel connections.
        if (!isRemoteConnection(kernel.kernelConnectionMetadata) || cell.document.isUntitled) {
            return;
        }
        this.executedCells.delete(cell);

        let disposable: IDisposable | undefined;
        const disposables: IDisposable[] = [];
        const anyMessageHandler = (_: unknown, msg: IAnyMessageArgs) => {
            if (msg.direction === 'send') {
                const request = msg.msg as KernelMessage.IExecuteRequestMsg;
                if (
                    request.header.msg_type === 'execute_request' &&
                    request.metadata &&
                    typeof request.metadata === 'object' &&
                    request.metadata &&
                    'cellId' in request.metadata &&
                    typeof request.metadata.cellId === 'string' &&
                    request.metadata.cellId === cell.document.uri.toString()
                ) {
                    const msg_id = request.header.msg_id;
                    this.executedCells.set(cell, {
                        msg_id,
                        kernelId: kernel.session?.kernel?.id || '',
                        cellIndex: cell.index
                    });
                }
            } else if (msg.direction === 'recv') {
                const ioPub = msg.msg as KernelMessage.IIOPubMessage;
                const info = this.executedCells.get(cell);
                if (info?.msg_id && getParentHeaderMsgId(ioPub) === info.msg_id) {
                    if (!info.startTime) {
                        info.startTime = new Date().getTime();
                        try {
                            // Time from the kernel is more accurate.
                            info.startTime = new Date(ioPub.header.date).getTime();
                        } catch {
                            // Ignore.
                        }
                        this.executedCells.set(cell, info);
                    }
                    if (
                        'execution_count' in ioPub.content &&
                        typeof ioPub.content.execution_count === 'number' &&
                        !info.executionCount
                    ) {
                        if (info.executionCount !== ioPub.content.execution_count) {
                            info.executionCount = ioPub.content.execution_count;
                            this.executedCells.set(cell, info);
                            this.trackLastExecution(cell, kernel, info);
                            disposeAllDisposables(disposables);
                        }
                    }
                }
            }
        };

        const hookUpSession = () => {
            if (!kernel?.session?.kernel) {
                return;
            }
            kernel.session.kernel.anyMessage.connect(anyMessageHandler);
            disposable = new Disposable(() =>
                swallowExceptions(() => kernel.session?.kernel?.anyMessage?.disconnect(anyMessageHandler))
            );
            disposables.push(disposable);
        };
        kernel.onStarted(() => hookUpSession(), disposables);
        if (kernel.session) {
            hookUpSession();
        }
    }
    public deleteTrackedCellExecution(cell: NotebookCell, kernel: IKernel) {
        if (cell.notebook.isUntitled) {
            return;
        }
        if (!isRemoteConnection(kernel.kernelConnectionMetadata)) {
            return;
        }

        const id = this.getStateKey(kernel.kernelConnectionMetadata.serverId);
        this.chainedPromises = this.chainedPromises.finally(() => {
            const notebookId = cell.notebook.uri.toString();
            const currentState = this.workspaceMemento.get<{ [key: string]: Partial<CellExecutionInfo> }>(id, {});
            if (currentState[notebookId].cellIndex === cell.index) {
                delete currentState[notebookId];
                return this.workspaceMemento.update(id, currentState).then(noop, noop);
            }
        });
    }
    private trackLastExecution(cell: NotebookCell, kernel: IKernel, info: Partial<CellExecutionInfo>) {
        if (!info.executionCount && !info.msg_id && !info.startTime) {
            return;
        }
        if (!isRemoteConnection(kernel.kernelConnectionMetadata)) {
            return;
        }

        const id = this.getStateKey(kernel.kernelConnectionMetadata.serverId);
        this.chainedPromises = this.chainedPromises.finally(() => {
            const notebookId = cell.notebook.uri.toString();
            const currentState = this.workspaceMemento.get<{ [key: string]: Partial<CellExecutionInfo> }>(id, {});
            currentState[notebookId] = info;
            return this.workspaceMemento.update(id, currentState).then(noop, noop);
        });
    }
    private onDidRemoveServerUris(removedServers: IJupyterServerUriEntry[]) {
        this.chainedPromises = this.chainedPromises.finally(() =>
            Promise.all(
                removedServers
                    .map((item) => this.getStateKey(item.serverId))
                    .map((id) => this.workspaceMemento.update(id, undefined).then(noop, noop))
            )
        );
    }
}

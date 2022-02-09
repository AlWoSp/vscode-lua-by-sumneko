import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as types from 'vscode-languageserver-types';
import {
    workspace as Workspace,
    ExtensionContext,
    env as Env,
    commands as Commands,
    TextDocument,
    WorkspaceFolder,
    Uri,
    window,
    TextEditor,
    Disposable,
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    DocumentSelector,
} from 'vscode-languageclient/node';
import { ConfigWatcher, IConfigUpdate } from "./ConfigWatcher";


let defaultClient: LuaClient;
let editorConfigWatcher: ConfigWatcher;

type HintResult = {
    text: string,
    pos:  types.Position,
    kind: types.integer,
}

function registerCustomCommands(context: ExtensionContext) {
    context.subscriptions.push(Commands.registerCommand('lua.config', (changes) => {
        let propMap: Map<string, Map<string, any>> = new Map();
        for (const data of changes) {
            let config = Workspace.getConfiguration(undefined, Uri.parse(data.uri));
            if (data.action == 'add') {
                let value: any[] = config.get(data.key);
                value.push(data.value);
                config.update(data.key, value, data.global);
                continue;
            }
            if (data.action == 'set') {
                config.update(data.key, data.value, data.global);
                continue;
            }
            if (data.action == 'prop') {
                if (!propMap[data.key]) {
                    propMap[data.key] = config.get(data.key);
                }
                propMap[data.key][data.prop] = data.value;
                config.update(data.key, propMap[data.key], data.global);
                continue;
            }
        }
    }))
}

function registerConfigWatch(context: ExtensionContext) {
    editorConfigWatcher = new ConfigWatcher('**/.editorconfig');

    editorConfigWatcher.onConfigUpdate(onEditorConfigUpdate);
    context.subscriptions.push(editorConfigWatcher);
}

function onEditorConfigUpdate(e: IConfigUpdate) {
    defaultClient?.client?.sendRequest('config/editorconfig/update', e);
}

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
    if (_sortedWorkspaceFolders === void 0) {
        _sortedWorkspaceFolders = Workspace.workspaceFolders ? Workspace.workspaceFolders.map(folder => {
            let result = folder.uri.toString();
            if (result.charAt(result.length - 1) !== '/') {
                result = result + '/';
            }
            return result;
        }).sort(
            (a, b) => {
                return a.length - b.length;
            }
        ) : [];
    }
    return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
    let sorted = sortedWorkspaceFolders();
    for (let element of sorted) {
        let uri = folder.uri.toString();
        if (uri.charAt(uri.length - 1) !== '/') {
            uri = uri + '/';
        }
        if (uri.startsWith(element)) {
            return Workspace.getWorkspaceFolder(Uri.parse(element))!;
        }
    }
    return folder;
}

class LuaClient {

    public client: LanguageClient;
    private disposables = new Array<Disposable>();
    constructor(private context: ExtensionContext,
                private documentSelector: DocumentSelector) {
    }

    async start() {
        const editorConfigFiles = await editorConfigWatcher.watch();
        // Options to control the language client
        let clientOptions: LanguageClientOptions = {
            // Register the server for plain text documents
            documentSelector: this.documentSelector,
            progressOnInitialization: true,
            markdown: {
                isTrusted: true,
            },
            initializationOptions: {
                changeConfiguration: true,
                editorConfigFiles
            }
        };

        let config = Workspace.getConfiguration(undefined, vscode.workspace.workspaceFolders?.[0]);
        let commandParam: string[] = config.get("Lua.misc.parameters");
        let command: string;
        let platform: string = os.platform();
        let binDir: string;
        if ((await fs.promises.stat(this.context.asAbsolutePath('server/bin'))).isDirectory()) {
            binDir = 'bin';
        }
        switch (platform) {
            case "win32":
                command = this.context.asAbsolutePath(
                    path.join(
                        'server',
                        binDir ? binDir : 'bin-Windows',
                        'lua-language-server.exe'
                    )
                );
                break;
            case "linux":
                command = this.context.asAbsolutePath(
                    path.join(
                        'server',
                        binDir ? binDir : 'bin-Linux',
                        'lua-language-server'
                    )
                );
                await fs.promises.chmod(command, '777')
                break;
            case "darwin":
                command = this.context.asAbsolutePath(
                    path.join(
                        'server',
                        binDir ? binDir : 'bin-macOS',
                        'lua-language-server'
                    )
                );
                await fs.promises.chmod(command, '777')
                break;
        }

        let serverOptions: ServerOptions = {
            command: command,
            args:    commandParam,
        };

        this.client = new LanguageClient(
            'Lua',
            'Lua',
            serverOptions,
            clientOptions
        );

        //client.registerProposedFeatures();
        this.client.start();
        await this.client.onReady();
        this.onCommand();
        this.onDecorations();
        //onInlayHint(client);
        this.statusBar();
    }
   
    async stop() {
        this.client.stop();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    statusBar() {
        let client = this.client;
        let bar = window.createStatusBarItem();
        bar.text = 'Lua';
        bar.command = 'Lua.statusBar';
        this.disposables.push(Commands.registerCommand(bar.command, () => {
            client.sendNotification('$/status/click');
        }))
        this.disposables.push(client.onNotification('$/status/show', (params) => {
            bar.show();
        }))
        this.disposables.push(client.onNotification('$/status/hide', (params) => {
            bar.hide();
        }))
        this.disposables.push(client.onNotification('$/status/report', (params) => {
            bar.text    = params.text;
            bar.tooltip = params.tooltip;
        }))
        client.sendNotification('$/status/refresh');
        this.disposables.push(bar);
    }

    onCommand() {
        this.disposables.push(this.client.onNotification('$/command', (params) => {
            Commands.executeCommand(params.command, params.data);
        }));
    }

    onDecorations() {
        let client = this.client;
        let textType = window.createTextEditorDecorationType({});

        function notifyVisibleRanges(textEditor: TextEditor) {
            if (!isDocumentInClient(textEditor.document, client)) {
                return;
            }
            let uri:    types.DocumentUri = client.code2ProtocolConverter.asUri(textEditor.document.uri);
            let ranges: types.Range[] = [];
            for (let index = 0; index < textEditor.visibleRanges.length; index++) {
                const range = textEditor.visibleRanges[index];
                ranges[index] = client.code2ProtocolConverter.asRange(new vscode.Range(
                    Math.max(range.start.line - 3, 0),
                    range.start.character,
                    Math.min(range.end.line + 3, textEditor.document.lineCount - 1),
                    range.end.character
                ));
            }
            for (let index = ranges.length; index > 1; index--) {
                const current = ranges[index];
                const before = ranges[index - 1];
                if (current.start.line > before.end.line) {
                    continue;
                }
                if (current.start.line == before.end.line && current.start.character > before.end.character) {
                    continue;
                }
                ranges.pop();
                before.end = current.end;
            }
            client.sendNotification('$/didChangeVisibleRanges', {
                uri:    uri,
                ranges: ranges,
            })
        }

        for (let index = 0; index < window.visibleTextEditors.length; index++) {
            notifyVisibleRanges(window.visibleTextEditors[index]);
        }

        this.disposables.push(window.onDidChangeVisibleTextEditors((params: TextEditor[]) => {
            for (let index = 0; index < params.length; index++) {
                notifyVisibleRanges(params[index]);
            }
        }))

        this.disposables.push(window.onDidChangeTextEditorVisibleRanges((params: vscode.TextEditorVisibleRangesChangeEvent) => {
            notifyVisibleRanges(params.textEditor);
        }))

        this.disposables.push(client.onNotification('$/hint', (params) => {
            let uri:        types.URI = params.uri;
            for (let index = 0; index < window.visibleTextEditors.length; index++) {
                const editor = window.visibleTextEditors[index];
                if (editor.document.uri.toString() == uri && isDocumentInClient(editor.document, client)) {
                    let textEditor = editor;
                    let edits: HintResult[] = params.edits
                    let options: vscode.DecorationOptions[] = [];
                    for (let index = 0; index < edits.length; index++) {
                        const edit = edits[index];
                        let pos = client.protocol2CodeConverter.asPosition(edit.pos);
                        options[index] = {
                            hoverMessage:  edit.text,
                            range:         new vscode.Range(pos, pos),
                            renderOptions: {
                                light: {
                                    after: {
                                        contentText:     edit.text,
                                        color:           '#888888',
                                        backgroundColor: '#EEEEEE;border-radius: 5px;',
                                        fontWeight:      '400; font-size: 12px; line-height: 1;',
                                    }
                                },
                                dark: {
                                    after: {
                                        contentText:     edit.text,
                                        color:           '#888888',
                                        backgroundColor: '#333333;border-radius: 5px;',
                                        fontWeight:      '400; font-size: 12px; line-height: 1;',
                                    }
                                }
                            }
                        }
                    }
                    textEditor.setDecorations(textType, options);
                }
            }
        }))
    }
}

function isDocumentInClient(textDocuments: TextDocument, client: LanguageClient): boolean {
    let selectors = client.clientOptions.documentSelector;
    if (!DocumentSelector.is(selectors)) {{
        return false;
    }}
    if (vscode.languages.match(selectors, textDocuments)) {
        return true;
    }
    return false;
}

function onInlayHint(client: LanguageClient) {
    vscode.languages.registerInlayHintsProvider(client.clientOptions.documentSelector, {
        provideInlayHints: async (model: TextDocument, range: vscode.Range): Promise<vscode.InlayHint[]> => {
            let pdoc    = client.code2ProtocolConverter.asTextDocumentIdentifier(model);
            let prange  = client.code2ProtocolConverter.asRange(range);
            let results: HintResult[] = await client.sendRequest('$/requestHint', {
                textDocument: pdoc,
                range:        prange,
            });
            if (!results) {
                return [];
            }
            let hints: vscode.InlayHint[] = [];
            for (const result of results) {
                let hint = new vscode.InlayHint(
                    result.text,
                    client.protocol2CodeConverter.asPosition(result.pos),
                    result.kind
                );
                hints.push(hint);
            }
            return hints;
        }
    })
}

export function activate(context: ExtensionContext) {
    registerCustomCommands(context);
    registerConfigWatch(context);
    function didOpenTextDocument(document: TextDocument) {
        // We are only interested in language mode text
        if (document.languageId !== 'lua' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
            return;
        }

        // Untitled files go to a default client.
        if (!defaultClient) {
            defaultClient = new LuaClient(context, [
                { language: 'lua' }
            ]);
            defaultClient.start();
            return;
        }
    }

    Workspace.onDidOpenTextDocument(didOpenTextDocument);
    Workspace.textDocuments.forEach(didOpenTextDocument);
    Workspace.onDidChangeWorkspaceFolders(() => {
        if (defaultClient) {
            defaultClient.stop();
            defaultClient = new LuaClient(context, [
                { language: 'lua' }
            ]);
            defaultClient.start();
        }
    });
}

export async function deactivate() {
    if (defaultClient) {
        defaultClient.stop();
        defaultClient = null;
    }
    return undefined;
}

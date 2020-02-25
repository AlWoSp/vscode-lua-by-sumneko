/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { workspace, ExtensionContext, env } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	let language = env.language;

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'lua' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	//let beta: boolean = workspace.getConfiguration("Lua.awakened").get("cat");
	let beta: boolean = false;
	let develop: boolean = workspace.getConfiguration("Lua.develop").get("enable");
	let debuggerPort: number = workspace.getConfiguration("Lua.develop").get("debuggerPort");
	let debuggerWait: boolean = workspace.getConfiguration("Lua.develop").get("debuggerWait");
	let command: string;
	let platform: string = os.platform();
	switch (platform) {
		case "win32":
			command = context.asAbsolutePath(
				path.join(
					'server',
					'bin',
					'Windows',
					'lua-language-server.exe'
				)
			);
			break;
		case "linux":
			command = context.asAbsolutePath(
				path.join(
					'server',
					'bin',
					'Linux',
					'lua-language-server'
				)
			);
			fs.chmodSync(command, '777');
			break;
		case "darwin":
			command = context.asAbsolutePath(
				path.join(
					'server',
					'bin',
					'macOS',
					'lua-language-server'
				)
			);
			fs.chmodSync(command, '777');
			break;
	}

	let serverOptions: ServerOptions = {
		command: command,
		args: [
			'-E',
			'-e',
			`LANG="${language}";DEVELOP=${develop};DBGPORT=${debuggerPort};DBGWAIT=${debuggerWait}`,
			context.asAbsolutePath(path.join(
				'server',
				beta ? 'main-beta.lua' : 'main.lua',
			))
		]
	};

	client = new LanguageClient(
		'Lua',
		'Lua',
		serverOptions,
		clientOptions
	);

	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

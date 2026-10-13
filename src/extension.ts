import * as vscode from "vscode";
import * as path from "path";

type Todo = {
    text: string;
    line: number;
};

const ACTIVE_PREFIX = "TODO: ";
const STRIKE_PREFIX = "~~";
const STRIKE_SUFFIX = "~~";

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "helloworld" is now active!');
    const createNotesCommand = vscode.commands.registerCommand( // If a keybind is pressed a new note file(if it doesnt exist), named 'notes-<filename>.txt' is created in the directory /notes
        "extension.keybinds_processing",
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage("No file is currently open.");
                return;
            }
            const sourcePath = editor.document.uri.fsPath;
            const sourceName = path.basename(sourcePath);
            const notesDirectory = path.join(path.dirname(sourcePath), "notes");
            const notesPath = path.join(notesDirectory, `notes-${sourceName}.txt`);
            const notesUri = vscode.Uri.file(notesPath);
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(notesDirectory));
			try {
				await vscode.workspace.fs.stat(notesUri);
			} catch {
				await vscode.workspace.fs.writeFile(notesUri, Buffer.from("", "utf8"));
			}
			const notesDocument = await vscode.workspace.openTextDocument(notesUri);
			await vscode.window.showTextDocument(notesDocument, {viewColumn: vscode.ViewColumn.Beside, preview: false});
			await syncTodos(editor.document);
        }
    );
    context.subscriptions.push(createNotesCommand);

    function getNotesUri(document: vscode.TextDocument): vscode.Uri { // Returns a notes file location for current file
        const sourcePath = document.uri.fsPath;
        const sourceName = path.basename(sourcePath);
        return vscode.Uri.file(path.join(path.dirname(sourcePath), "notes", `notes-${sourceName}.txt`));
    }

    async function syncTodos(document: vscode.TextDocument) { //finds notes in current file and syncs them with notes file
        if (document.isClosed || document.uri.scheme !== "file" || path.basename(path.dirname(document.uri.fsPath)) === "notes") {
            return;
        }
        const sourceName = path.basename(document.uri.fsPath);
        const notesUri = getNotesUri(document);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(notesUri.fsPath)));
        const currentTodos: Todo[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
			const regex = /\bTODO\b\s*:?\s*(.*?)(?=\s+\bTODO\b\s*:?\s*|$)/g;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(lineText)) !== null) {
                const text = match[1].trim();
                if (text.length > 0) {
                    currentTodos.push({text, line: i + 1});
                }
            }
        }
        // Read existing notes without overwriting personal notes
        let existingLines: string[] = [];
		const bytes = await vscode.workspace.fs.readFile(notesUri);
		existingLines = Buffer.from(bytes).toString("utf8").split(/\r?\n/);
		if (existingLines.length === 1 && existingLines[0] === "") {
			existingLines = [];
		}

        function parseTodo(line: string) { // converts lines in notes file into structure
            const normalized = line.replace(/^~~/, "").replace(/~~$/, "");
            const match = normalized.match(/^TODO: (.*) -> (.+):(\d+)$/);
            if (!match) {
                return undefined;
            }
            return {
                text: match[1],
                file: match[2],
                line: Number(match[3]),
            };
        }

        function identity(text: string, file: string) { //returns a key for specific todo, the key is formed from filename and text
            return `${file}\0${text}`;
        }

        const remainingTodos = new Map<string, Todo[]>();
        for (const todo of currentTodos) {
            const key = identity(todo.text, sourceName);
            const group = remainingTodos.get(key) ?? [];
            group.push(todo);
            remainingTodos.set(key, group);
        }
        const output: string[] = [];
        for (const line of existingLines) {
            const parsed = parseTodo(line);
            if (!parsed || parsed.file !== sourceName) {
                output.push(line);
                continue;
            }
            const isStruck = line.startsWith(STRIKE_PREFIX) && line.endsWith(STRIKE_SUFFIX);
            if (isStruck) {
                output.push(line);
                continue;
            }
            const key = identity(parsed.text, parsed.file);
            const matches = remainingTodos.get(key);
            if (matches && matches.length > 0) {
                const todo = matches.shift()!;
                output.push(`${ACTIVE_PREFIX}${todo.text} -> ${sourceName}:${todo.line}`);
            } else {
                output.push(`${STRIKE_PREFIX}${line}${STRIKE_SUFFIX}`);
            }
        }
        for (const todos of remainingTodos.values()) {
            for (const todo of todos) {
                output.push(`${ACTIVE_PREFIX}${todo.text} -> ${sourceName}:${todo.line}`);
            }
        }
        await vscode.workspace.fs.writeFile(notesUri,Buffer.from(output.join("\n"), "utf8"));
        refreshOpenNotes();
    }

    // Visually strike through entries surrounded by ~~ markers.
    const strikeDecoration = vscode.window.createTextEditorDecorationType({textDecoration: "line-through"});

    function updateStrikethrough(editor: vscode.TextEditor) { //add strikethrough to deleted/changed notes
        const ranges: vscode.Range[] = [];
        for (let i = 0; i < editor.document.lineCount; i++) {
            const text = editor.document.lineAt(i).text;
            if (text.startsWith(STRIKE_PREFIX) && text.endsWith(STRIKE_SUFFIX) && text.length >= 4) {
                ranges.push(new vscode.Range(new vscode.Position(i, 2), new vscode.Position(i, text.length - 2)));
            }
        }
        editor.setDecorations(strikeDecoration, ranges);
    }

    function refreshOpenNotes() { //calls strikethrough update function
        for (const editor of vscode.window.visibleTextEditors) {
            if (path.basename(path.dirname(editor.document.uri.fsPath)) === "notes") {
                updateStrikethrough(editor);
            }
        }
    }

    const timers = new Map<string,ReturnType<typeof setTimeout>>();
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const document = event.document;
            if (document.uri.scheme !== "file" || path.basename(path.dirname(document.uri.fsPath)) === "notes") {
                return;
            }
            const key = document.uri.toString();
            const previousTimer = timers.get(key);
            if (previousTimer) {
                clearTimeout(previousTimer);
            }
            timers.set(key,
                setTimeout(() => {
                    timers.delete(key);
                    void syncTodos(document).catch((error) => {
                        vscode.window.showErrorMessage(
                            `TODO scan failed: ${String(error)}`
                        );
                    });
                }, 1500)
            );
        }),
        vscode.window.onDidChangeVisibleTextEditors(refreshOpenNotes),
        vscode.workspace.onDidOpenTextDocument(() => {
            refreshOpenNotes();
        }),
        strikeDecoration,
        {
            dispose: () => {
                for (const timer of timers.values()) {
                    clearTimeout(timer);
                }
                timers.clear();
            }
        }
    );

    refreshOpenNotes();

    const documentLinkProvider =
        vscode.languages.registerDocumentLinkProvider( // clickable source-file references in notes files
            {
                scheme: "file",
                pattern: "**/notes/*.txt",
            },
            {
                provideDocumentLinks(document) {
                    const links: vscode.DocumentLink[] = [];
                    const text = document.getText();
                    const regex = /([a-zA-Z0-9_.-]+):(\d+)/g;
                    let match: RegExpExecArray | null;
                    while ((match = regex.exec(text)) !== null) {
                        const fileName = match[1];
                        const lineNumber = Number(match[2]);
                        const sourcePath = path.join(path.dirname(path.dirname(document.uri.fsPath)), fileName);
                        const sourceUri = vscode.Uri.file(sourcePath);
                        const target = vscode.Uri.parse(`${sourceUri.toString()}#L${lineNumber},1`);
                        const start = document.positionAt(match.index);
                        const end = document.positionAt(match.index + match[0].length);
                        links.push(new vscode.DocumentLink(new vscode.Range(start, end), target));
                    }
                    return links;
                }
            }
        );

    context.subscriptions.push(documentLinkProvider);
}
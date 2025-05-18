import * as vscode from 'vscode'
import { requestLLMReviewWithFunctionCalling, LLM_CONFIG } from './llm-client'
import { isTextDocument, shouldExclude } from './utils'

const lastRunMap = new Map<string, number>()

const llmWriteEditConfig = vscode.workspace.getConfiguration('llmWriteEdit')
const EXCLUDE_PATTERNS = llmWriteEditConfig.get<string[]>(
	'excludePatterns'
) || ['.venv/**', '**/.venv/**']
const INCLUDE_PATTERNS =
	llmWriteEditConfig.get<string[]>('includePatterns') || []

const LLM_REVIEWER_CONSOLE =
        vscode.window.createOutputChannel('llm-text-review')
const diagnosticCollection =
        vscode.languages.createDiagnosticCollection('llm-text-review')

LLM_REVIEWER_CONSOLE.appendLine('[llm-text-review] 拡張機能が初期化されました')


export async function activate(ctx: vscode.ExtensionContext) {
	const { default: PQueue } = await import('p-queue')
	const queue = new PQueue({ concurrency: 2 })

	const lintIfNeeded = (doc: vscode.TextDocument) => {
                LLM_REVIEWER_CONSOLE.appendLine(
                        `[llm-text-review] lintIfNeeded called for ${doc.fileName}`
                )
		if (doc.isUntitled) return
		if (!isTextDocument(doc.languageId)) return
                if (shouldExclude(doc.uri.fsPath, EXCLUDE_PATTERNS, INCLUDE_PATTERNS)) {
			return
		}
		queue.add(
			async () => {
				try {
					await lintDocument(doc)
				} catch (error) {}
			},
			{ throwOnTimeout: false }
		)
	}

	let autoReviewEnabled = true
	let autoReviewOnOpenEnabled = llmWriteEditConfig.get<boolean>(
		'autoReviewOnOpen',
		true
	)

	const reviewCommand = vscode.commands.registerCommand(
		'llmWriteEdit.reviewCurrentFile',
		async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				return
			}

			const doc = editor.document
			if (doc.isUntitled) {
				return
			}

			if (!isTextDocument(doc.languageId)) {
				return
			}

                        if (shouldExclude(doc.uri.fsPath, EXCLUDE_PATTERNS, INCLUDE_PATTERNS)) {
				return
			}

			lastRunMap.set(doc.uri.toString(), 0)
			await lintDocument(doc)
		}
	)

	const toggleAutoReviewCommand = vscode.commands.registerCommand(
		'llmWriteEdit.toggleAutoReview',
		() => {
			autoReviewEnabled = !autoReviewEnabled
		}
	)

	const toggleAutoReviewOnOpenCommand = vscode.commands.registerCommand(
		'llmWriteEdit.toggleAutoReviewOnOpen',
		() => {
			autoReviewOnOpenEnabled = !autoReviewOnOpenEnabled
			vscode.workspace
				.getConfiguration()
				.update(
					'llmWriteEdit.autoReviewOnOpen',
					autoReviewOnOpenEnabled,
					vscode.ConfigurationTarget.Global
				)
		}
	)

	const onSaveSubscription = vscode.workspace.onDidSaveTextDocument((doc) => {
		if (autoReviewEnabled) {
			lintIfNeeded(doc)
		}
	})

	const onOpenSubscription = vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (editor && autoReviewOnOpenEnabled) {
				const doc = editor.document
				lintIfNeeded(doc)
			}
		}
	)

	if (vscode.window.activeTextEditor && autoReviewOnOpenEnabled) {
		const doc = vscode.window.activeTextEditor.document
		setTimeout(() => lintIfNeeded(doc), 2000)
	}

	ctx.subscriptions.push(
		reviewCommand,
		toggleAutoReviewCommand,
		toggleAutoReviewOnOpenCommand,
		onSaveSubscription,
		onOpenSubscription,
		vscode.workspace.onDidCloseTextDocument((doc) => {
			diagnosticCollection.delete(doc.uri)
		}),
		LLM_REVIEWER_CONSOLE,
		diagnosticCollection
	)
}

function updateDiagnostics(doc: vscode.TextDocument, reviewText: string): void {
	const activeDocs = vscode.window.visibleTextEditors.map((e) =>
		e.document.uri.toString()
	)
	if (!activeDocs.includes(doc.uri.toString())) {
		diagnosticCollection.delete(doc.uri)
		return
	}
	const diagnostics: vscode.Diagnostic[] = []
	const lines = reviewText
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)

	for (const line of lines) {
		const severityMatch = line.match(
			/^\[(ERROR|WARNING|INFO|HINT)\]\s*:?\s*(.+?)(?:\s+\[Ln\s+(\d+)(?:,\s*Col\s+(\d+))?\])?$/i
		)

		if (severityMatch) {
			const severityText = severityMatch[1].toUpperCase()
			const content = severityMatch[2].trim()
			const lineNumber = severityMatch[3]
				? parseInt(severityMatch[3], 10) - 1
				: 0
			const colNumber = severityMatch[4]
				? parseInt(severityMatch[4], 10)
				: 0

			let diagnosticSeverity: vscode.DiagnosticSeverity
			switch (severityText) {
				case 'ERROR':
					diagnosticSeverity = vscode.DiagnosticSeverity.Error
					break
				case 'WARNING':
					diagnosticSeverity = vscode.DiagnosticSeverity.Warning
					break
				default:
					diagnosticSeverity = vscode.DiagnosticSeverity.Information
			}

			const safeLineNumber = Math.max(
				0,
				Math.min(lineNumber, doc.lineCount - 1)
			)

			const line = doc.lineAt(safeLineNumber)
			const range = new vscode.Range(
				safeLineNumber,
				Math.min(colNumber, line.text.length),
				safeLineNumber,
				line.text.length
			)

			const diagnostic = new vscode.Diagnostic(
				range,
				content,
				diagnosticSeverity
			)
			diagnostic.source = 'LLM Reviewer'
			diagnostics.push(diagnostic)
		}
	}

	diagnosticCollection.set(doc.uri, diagnostics)
}

async function lintDocument(doc: vscode.TextDocument): Promise<void> {
        const uriString = doc.uri.toString()
        const now = Date.now()
	const last = lastRunMap.get(uriString) ?? 0
	if (now - last < 30000) {
		return
	}
	lastRunMap.set(uriString, now)

	try {
		const statusMessage =
			vscode.window.setStatusBarMessage('LLMによるレビュー実行中...')

		let fullText: string
		try {
			fullText = await requestLLMReviewWithFunctionCalling(doc)
		} catch (llmError) {
			statusMessage.dispose()
			return
		}
		diagnosticCollection.delete(doc.uri)
		updateDiagnostics(doc, fullText)
		statusMessage.dispose()
	} catch (error) {}
}

export function deactivate() {
	lastRunMap.clear()
	LLM_REVIEWER_CONSOLE.dispose()
}

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

function cfg<T>(key: string): T {
	return vscode.workspace.getConfiguration('llmWriteEdit').get<T>(key)!
}

export const LLM_CONFIG = {
        MODEL: cfg<string>('model'),
        PORT: cfg<number>('port'),
        THREADS: cfg<number>('threads'),
        CUSTOM_INSTRUCTION_FILE: cfg<string>('customInstructionFile'),
}

interface FunctionCallResponse {
	id: string
	object: string
	created: number
	model: string
	choices: Array<{
		index: number
		message: {
			role: string
			content: string | null
			function_call?: {
				name: string
				arguments: string
			}
			tool_calls?: Array<{
				id: string
				type: string
				function: {
					name: string
					arguments: string
				}
			}>
		}
		finish_reason: string
	}>
}

interface ReviewItem {
	severity: 'ERROR' | 'WARNING' | 'INFO' | 'HINT'
	message: string
	codeSnippet?: string
}

const reviewFunctions = [
	{
		type: 'function',
		function: {
			description:
				'文章の誤字脱字・悪文・表現ミス・不自然な日本語・読みづらさ・論理の飛躍・冗長表現などをレビューし、問題点を指摘します',
			name: 'reviewText',
			parameters: {
				type: 'object',
				properties: {
					reviews: {
						type: 'array',
						description: 'レビュー結果の配列',
						items: {
							type: 'object',
							properties: {
								severity: {
									type: 'string',
									enum: ['ERROR', 'WARNING', 'INFO', 'HINT'],
									description:
										'問題の重要度（ERROR:誤字脱字や意味不明な文、WARNING:不自然な表現や論理の飛躍、INFO:改善提案、HINT:細かな表現やスタイル）',
								},
								message: {
									type: 'string',
									description:
										'問題の内容説明（日本語で簡潔に記述）',
								},
								codeSnippet: {
									type: 'string',
									description:
										'問題のある該当文やフレーズ。行番号は不要で、最小限の判別可能な文章断片を記載。',
								},
							},
							required: ['severity', 'message'],
						},
					},
				},
				required: ['reviews'],
			},
		},
	},
]

async function readCustomInstructions(): Promise<string | null> {
        const file = LLM_CONFIG.CUSTOM_INSTRUCTION_FILE
        if (!file) {
                return null
        }
        let targetPath = file
        if (!path.isAbsolute(file)) {
                const folders = vscode.workspace.workspaceFolders
                if (folders && folders.length > 0) {
                        targetPath = path.join(folders[0].uri.fsPath, file)
                }
        }
        try {
                return await fs.promises.readFile(targetPath, 'utf8')
        } catch {
                return null
        }
}

export async function requestLLMReviewWithFunctionCalling(
        doc: vscode.TextDocument
): Promise<string> {
        const promptLines = [
                '```',
                doc.getText(),
                '```',
		'上記の文章をレビューし、誤字脱字・悪文・表現ミス・不自然な日本語・読みづらさ・論理の飛躍・冗長表現などを診断してください。',
		'重要度は次の4つのいずれかから選択してください: [ERROR], [WARNING], [INFO], [HINT]',
		'- [ERROR]: 誤字脱字や意味不明な文、重大な論理破綻',
		'- [WARNING]: 不自然な表現、論理の飛躍、文法ミス',
		'- [INFO]: 改善提案やより良い表現',
		'- [HINT]: 細かな表現やスタイル、語尾、助詞の使い方など',
		'指摘は直接的で簡潔な日本語で、文章の改善点を具体的に示してください',
		'同じ問題の繰り返しは避け、各問題は一度だけ報告してください',
		'markdown形式の引用ブロック中は原文の表現に従ってください',
		'URLに:embedが含まれているのは、URLを埋め込むためであるため指摘不要',
		`ファイルパス: ${doc.fileName}`,
		`言語: ${doc.languageId}`,
		'文章の長さ: ' + doc.lineCount + '行',
		'',
		'重要：位置情報（行番号や列番号）を指定しないでください。代わりに、問題のある箇所を特定できる文章断片（フレーズや文）を提供してください。',
                '文章断片には最小限の必要なコンテキスト（特徴的な語句や前後の文脈）を含めてください。',
        ]

        const custom = await readCustomInstructions()
        if (custom) {
                promptLines.push(custom.trim())
        }

        const prompt = promptLines.join('\n')

	const body = {
		model: LLM_CONFIG.MODEL,
		temperature: 0,
		stream: false,
		messages: [{ role: 'user', content: prompt }],
		tools: reviewFunctions,
		tool_choice: 'auto',
	}

	try {
		const res = await fetch(
			`http://localhost:${LLM_CONFIG.PORT}/v1/chat/completions`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}
		)

		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${await res.text()}`)
		}

		const data = (await res.json()) as FunctionCallResponse

		try {
			const toolCalls = data.choices?.[0]?.message?.tool_calls
			if (toolCalls && toolCalls.length > 0) {
				for (const toolCall of toolCalls) {
					if (toolCall.function?.name === 'reviewText') {
						const functionCallResult = JSON.parse(
							toolCall.function.arguments
						)
						const formattedReviews = formatFunctionCallResults(
							functionCallResult,
							doc
						)
						return formattedReviews
					}
				}
			}
		} catch (error) {
			return 'レビュー結果がERRORです'
		}
	} catch (error) {
		return 'レビュー結果がERRORです'
	}
	return 'レビュー結果がありません'
}

function formatFunctionCallResults(
	result: { reviews: ReviewItem[] },
	doc: vscode.TextDocument
): string {
	if (!result.reviews || !Array.isArray(result.reviews)) {
		return 'レビュー結果がありません'
	}
	const formattedLines = result.reviews.map((review) => {
		let position = findPositionByCodeSnippet(review.codeSnippet, doc)
		let locationText = ''

		if (position) {
			locationText = ` [Ln ${position.line + 1}, Col ${
				position.character
			}]`
		}

		return `[${review.severity}]${review.message}${locationText}`
	})

	return formattedLines.join('\n')
}

function findPositionByCodeSnippet(
	snippet: string | undefined,
	doc: vscode.TextDocument
): vscode.Position | null {
	if (!snippet) {
		return null
	}

	const escapedSnippet = snippet
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.trim()
		.replace(/\s+/g, '\\s+')

	try {
		const regex = new RegExp(escapedSnippet, 'g')
		const docText = doc.getText()

		const match = regex.exec(docText)
		if (match) {
			const offset = match.index
			return doc.positionAt(offset)
		}
	} catch (e) {}

	if (snippet.length > 15) {
		const docText = doc.getText()
		const words = snippet
			.split(/\s+/)
			.filter((word) => word.length > 3)
			.slice(0, 3)

		for (const word of words) {
			const index = docText.indexOf(word)
			if (index >= 0) {
				const contextStart = Math.max(0, index - 50)
				const contextEnd = Math.min(docText.length, index + 50)
				const context = docText.substring(contextStart, contextEnd)

				if (words.filter((w) => context.includes(w)).length >= 2) {
					return doc.positionAt(index)
				}
			}
		}
	}

	return null
}

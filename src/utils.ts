import * as vscode from 'vscode'
import { relative } from 'path'
import { minimatch } from 'minimatch'

export const TEXT_DOCUMENT_LANGUAGE_IDS = new Set([
    'markdown',
    'plaintext',
    'latex',
    'tex',
    'rst',
    'org',
    'md',
    'txt',
])

export function isTextDocument(languageId: string): boolean {
    return TEXT_DOCUMENT_LANGUAGE_IDS.has(languageId)
}

export function getRelativePath(fsPath: string): string | null {
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
        return null
    }

    for (const folder of folders) {
        const folderPath = folder.uri.fsPath
        if (fsPath.startsWith(folderPath)) {
            return relative(folderPath, fsPath).replace(/\\/g, '/')
        }
    }

    return null
}

export function shouldExclude(
    fsPath: string,
    excludePatterns: string[],
    includePatterns: string[],
): boolean {
    const relativePath = getRelativePath(fsPath)
    if (!relativePath) {
        return false
    }

    if (includePatterns.length > 0) {
        const included = includePatterns.some((pattern) =>
            minimatch(relativePath, pattern, { dot: true, matchBase: true })
        )
        if (!included) {
            return true
        }
    }

    return excludePatterns.some((pattern) =>
        minimatch(relativePath, pattern, { dot: true, matchBase: true })
    )
}

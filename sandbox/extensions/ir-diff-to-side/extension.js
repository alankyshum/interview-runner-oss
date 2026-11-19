const fs = require('fs')
const path = require('path')
const vscode = require('vscode')

const defaultLayout = { primarySidebarVisible: true, primaryView: 'explorer', secondarySidebarVisible: false, panelVisible: false }
const json = (value, fallback) => { try { return JSON.parse(value) } catch { return fallback } }
const safePath = value => typeof value === 'string' && value && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..')

async function activate(context) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  const savedLayout = json(process.env.IR_SAVED_LAYOUT, undefined)
  const savedEditors = process.env.IR_SAVED_EDITORS === undefined ? undefined : json(process.env.IR_SAVED_EDITORS, undefined)
  const editable = json(process.env.IR_EDITABLE_PATHS || '[]', [])
  const statePath = process.env.IR_UI_STATE_PATH
  let currentLayout = savedLayout || { ...defaultLayout }
  let saveTimer

  const editorState = () => {
    if (!root) return []
    const output = []
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.scheme !== 'file') continue
      const relative = path.relative(root.fsPath, tab.input.uri.fsPath).replaceAll('\\', '/')
      if (safePath(relative)) output.push({ path: relative, viewColumn: Number(group.viewColumn), active: tab.isActive })
    }
    return output.slice(0, 32)
  }
  const persist = async () => {
    if (!statePath) return
    const temporary = `${statePath}.${process.pid}.tmp`
    try { await fs.promises.writeFile(temporary, `${JSON.stringify({ version: 1, layout: currentLayout, editors: editorState() })}\n`); await fs.promises.rename(temporary, statePath) } catch { await fs.promises.rm(temporary, { force: true }).catch(() => {}) }
  }
  const schedulePersist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void persist() }, 100) }
  context.subscriptions.push({ dispose: () => clearTimeout(saveTimer) })

  const command = (id, builtIn, update) => context.subscriptions.push(vscode.commands.registerCommand(id, async () => { await vscode.commands.executeCommand(builtIn); currentLayout = update(currentLayout); schedulePersist() }))
  command('interview-runner.viewExplorer', 'workbench.view.explorer', value => ({ ...value, primarySidebarVisible: true, primaryView: 'explorer' }))
  command('interview-runner.viewSourceControl', 'workbench.view.scm', value => ({ ...value, primarySidebarVisible: true, primaryView: 'scm' }))
  command('interview-runner.togglePrimarySidebar', 'workbench.action.toggleSidebarVisibility', value => ({ ...value, primarySidebarVisible: !value.primarySidebarVisible }))
  command('interview-runner.toggleSecondarySidebar', 'workbench.action.toggleAuxiliaryBar', value => ({ ...value, secondarySidebarVisible: !value.secondarySidebarVisible }))
  command('interview-runner.togglePanel', 'workbench.action.togglePanel', value => ({ ...value, panelVisible: !value.panelVisible }))

  await vscode.commands.executeCommand(currentLayout.primaryView === 'scm' ? 'workbench.view.scm' : 'workbench.view.explorer')
  if (!currentLayout.primarySidebarVisible) await vscode.commands.executeCommand('workbench.action.closeSidebar')
  await vscode.commands.executeCommand(currentLayout.secondarySidebarVisible ? 'workbench.action.focusAuxiliaryBar' : 'workbench.action.closeAuxiliaryBar')
  await vscode.commands.executeCommand(currentLayout.panelVisible ? 'workbench.action.focusPanel' : 'workbench.action.closePanel')

  const initialEditors = savedEditors === undefined ? editable.map(file => ({ path: file, viewColumn: 1, active: false })) : savedEditors
  if (root && Array.isArray(initialEditors)) for (const editor of [...initialEditors].sort((left, right) => Number(left.active) - Number(right.active))) {
    if (!editor || !safePath(editor.path) || !Number.isInteger(editor.viewColumn) || editor.viewColumn < 1 || editor.viewColumn > 9) continue
    try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ...editor.path.split('/'))), { viewColumn: editor.viewColumn, preserveFocus: !editor.active, preview: false }) } catch {}
  }

  let arranging = false
  const arrange = async () => {
    schedulePersist()
    const activeGroup = vscode.window.tabGroups.activeTabGroup
    const input = activeGroup.activeTab?.input
    if (arranging || !(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== 'git' || input.modified.scheme !== 'file') return
    arranging = true
    try {
      const leftColumn = activeGroup.viewColumn
      const rightGroup = vscode.window.tabGroups.all.find((group) => group.viewColumn === leftColumn + 1)
      const oldDiffs = rightGroup?.tabs.filter((tab) => tab.input instanceof vscode.TabInputTextDiff) ?? []
      if (oldDiffs.length) await vscode.window.tabGroups.close(oldDiffs, true)
      await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup')
      await vscode.window.showTextDocument(input.modified, { viewColumn: leftColumn, preserveFocus: false, preview: false })
    } finally { arranging = false; schedulePersist() }
  }
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => { void arrange() }), vscode.window.onDidChangeActiveTextEditor(schedulePersist))
  schedulePersist()
}

module.exports = { activate }

import * as vscode from "vscode"
import {
  lilypondExists,
  getConfiguration,
  getBinPath,
  setLilypondVersionInStatusBar,
} from "./util"
import { compile, CompileMode, initCompile, killCompilation } from "./lilypond"
import { subscribeIntellisense } from "./intellisense"
import { MIDIOut } from "./midi-out"
import { MIDIIn } from "./midi-in"
import { langId } from "./consts"

const goToPDFLocationFromCursorCommand =
  "lilypond-pdf-preview.goToPDFLocationFromCursor"

const restoreFocusToEditor = async (
  editor: vscode.TextEditor,
  selection: vscode.Selection
) => {
  await vscode.window.showTextDocument(editor.document, {
    viewColumn: editor.viewColumn,
    preserveFocus: false,
    preview: false,
    selection,
  })
}

export function activate(context: vscode.ExtensionContext) {
  // need to make sure `lilypond` exists
  if (!lilypondExists()) {
    vscode.window.showErrorMessage(
      `\`lilypond\` (${getBinPath()}) is not found in your system.`
    )
    return
  }
  setLilypondVersionInStatusBar(context)

  const config = getConfiguration()

  // ===== ===== ===== COMPILATION ===== ===== =====
  // init
  initCompile()

  // compile main file if exists, else compiles active file
  const compileCmd = vscode.commands.registerCommand(
    "vslilypond.compile",
    () => {
      compile()
    }
  )
  context.subscriptions.push(compileCmd)

  // compile to pdf
  const compileThisSpecificFileCmd = vscode.commands.registerCommand(
    "vslilypond.compileThisSpecificFile",
    () => {
      compile(CompileMode.onCompileSpecific)
    }
  )
  context.subscriptions.push(compileThisSpecificFileCmd)

  const killCompilationCmd = vscode.commands.registerCommand(
    "vslilypond.killCompilationProcess",
    () => {
      killCompilation(false)
    }
  )
  context.subscriptions.push(killCompilationCmd)

  // compile when a LilyPond editor becomes active
  if (config.compilation.compileOnOpen !== false) {
    const compiledOnOpenDocuments = new Set<string>()
    const compileOnOpenListener = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        const textDoc = editor?.document
        if (
          textDoc?.languageId === langId &&
          !compiledOnOpenDocuments.has(textDoc.uri.fsPath)
        ) {
          compiledOnOpenDocuments.add(textDoc.uri.fsPath)
          setTimeout(() => compile(CompileMode.onSave, true, textDoc), 100)
        }
      }
    )
    context.subscriptions.push(compileOnOpenListener)

    const activeTextDoc = vscode.window.activeTextEditor?.document
    if (activeTextDoc?.languageId === langId) {
      compiledOnOpenDocuments.add(activeTextDoc.uri.fsPath)
      setTimeout(() => compile(CompileMode.onSave, true, activeTextDoc), 100)
    }
  }

  // compile upon saving
  if (config.compilation.compileOnSave) {
    const compileOnSaveListener = vscode.workspace.onDidSaveTextDocument(
      (textDoc: vscode.TextDocument) => {
        if (textDoc.languageId === langId) {
          compile(CompileMode.onSave, true, textDoc)
        }
      }
    )
    context.subscriptions.push(compileOnSaveListener)
  }

  if (config.compilation.goToPdfOnSelection !== false) {
    let goToPdfOnSelectionTimeout: ReturnType<typeof setTimeout> | undefined
    const goToPdfOnSelectionListener =
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const { textEditor } = event
        if (textEditor.document.languageId !== langId) {
          return
        }

        if (
          textEditor.selections.length !== 1 ||
          textEditor.selection.isEmpty
        ) {
          return
        }

        if (goToPdfOnSelectionTimeout) {
          clearTimeout(goToPdfOnSelectionTimeout)
        }

        const sourceSelection = textEditor.selection
        goToPdfOnSelectionTimeout = setTimeout(async () => {
          await vscode.commands.executeCommand(goToPDFLocationFromCursorCommand)
          await restoreFocusToEditor(textEditor, sourceSelection)
          setTimeout(
            () => restoreFocusToEditor(textEditor, sourceSelection),
            100
          )
        }, 150)
      })

    context.subscriptions.push(goToPdfOnSelectionListener)
  }

  // ===== ===== ===== INTELLISENSE ===== ===== =====
  // intellisense
  if (config.intellisense.enabled) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection()
    subscribeIntellisense(context, diagnosticCollection)
  }

  // ===== ===== ===== MIDI PLAYBACK ===== ===== =====
  // play midi
  const playMidiCmd = vscode.commands.registerCommand(
    "vslilypond.playMIDI",
    () => {
      MIDIOut.playMIDI()
    }
  )
  context.subscriptions.push(playMidiCmd)

  // play midi from
  const playMidiFromCmd = vscode.commands.registerCommand(
    "vslilypond.playMIDIFrom",
    () => {
      MIDIOut.playMIDIFrom()
    }
  )
  context.subscriptions.push(playMidiFromCmd)

  // stop midi
  const stopMidiCmd = vscode.commands.registerCommand(
    "vslilypond.stopMIDI",
    () => {
      MIDIOut.stopMIDI()
    }
  )
  context.subscriptions.push(stopMidiCmd)

  // pause midi
  const pauseMidiCmd = vscode.commands.registerCommand(
    "vslilypond.pauseMIDI",
    () => {
      MIDIOut.pauseMIDI()
    }
  )
  context.subscriptions.push(pauseMidiCmd)

  // resume midi
  const resumeMidiCmd = vscode.commands.registerCommand(
    "vslilypond.resumeMIDI",
    () => {
      MIDIOut.resumeMIDI()
    }
  )
  context.subscriptions.push(resumeMidiCmd)

  // reset midi
  const resetMIDIOutputCmd = vscode.commands.registerCommand(
    "vslilypond.resetMIDIOutput",
    () => {
      MIDIOut.resetMIDI()
    }
  )
  context.subscriptions.push(resetMIDIOutputCmd)

  // set midi output device
  const setOutputMidiDeviceCmd = vscode.commands.registerCommand(
    "vslilypond.setOutputMIDIDevice",
    () => {
      MIDIOut.setOutputMIDIDevice()
    }
  )
  context.subscriptions.push(setOutputMidiDeviceCmd)

  // status bar items for MIDI playback
  MIDIOut.initMIDIStatusBarItems()

  // ===== ===== ===== MIDI INPUT ===== ===== =====
  // start midi input
  const startInputMidiCmd = vscode.commands.registerCommand(
    "vslilypond.startMIDIInput",
    () => {
      MIDIIn.startMIDIInput()
    }
  )
  context.subscriptions.push(startInputMidiCmd)

  // stop midi input
  const stopInputMidiCmd = vscode.commands.registerCommand(
    "vslilypond.stopMIDIInput",
    () => {
      MIDIIn.stopMIDIInput()
    }
  )
  context.subscriptions.push(stopInputMidiCmd)

  // set midi input device
  const setInputMidiDeviceCmd = vscode.commands.registerCommand(
    "vslilypond.setInputMIDIDevice",
    () => {
      MIDIIn.setInputMIDIDevice()
    }
  )
  context.subscriptions.push(setInputMidiDeviceCmd)

  // restart midi input
  const restartMIDIInputCmd = vscode.commands.registerCommand(
    "vslilypond.restartMIDIInput",
    () => {
      MIDIIn.restartMIDIInput()
    }
  )
  context.subscriptions.push(restartMIDIInputCmd)

  // status bar items for MIDI playback
  MIDIIn.initMIDIStatusBarItems()

  // ===== ===== ===== LISTENERS ===== ===== =====
  // we need to update status bar when active text editor changes
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  vscode.window.onDidChangeActiveTextEditor((_) => {
    MIDIIn.updateMIDIStatusBarItem()
    MIDIOut.updateMIDIStatusBarItem()
  })
}

// this method is called when your extension is deactivated
// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {}

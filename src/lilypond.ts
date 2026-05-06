import * as cp from "child_process"
import * as vscode from "vscode"
import {
  logger,
  LogLevel,
  getBinPath,
  getConfiguration,
  errMsgRegex,
} from "./util"
import { langId } from "./consts"
import * as path from "path"
import * as fs from "fs"

export enum CompileMode {
  onSave, // compile on save
  onCompile, // compile on command (vslilypond.compile)
  onCompileSpecific, // compile on command to compile specific file
}

type CompilerProcessType = {
  compileMode: CompileMode
  process: cp.ChildProcessWithoutNullStreams
}

let compileProcess: CompilerProcessType | undefined = undefined

// make ready an output channel
let compileOutputChannel: vscode.OutputChannel | undefined = undefined
export const initCompile = () => {
  compileOutputChannel = vscode.window.createOutputChannel(
    `VSLilyPond: Compilation`
  )
}

const getCompilingStatusBarItem = () => {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0
  )
  item.text = `$(sync~spin) Compiling...`
  item.tooltip = `You can kill the compilation process using the \`VSLilyPond: Kill Compilation Process\` command`
  return item
}

const showCompilationFailedStatusBarItem = (timeoutMS = 5000) => {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    0
  )
  item.text = `$(x) Compilation Failed`
  item.tooltip = `See the \`VSLilyPond: Compilation\` output for more information`
  item.show()
  setTimeout(() => item.hide(), timeoutMS)
}

const outputToChannel = async (msg: string, show = false) => {
  if (compileOutputChannel) {
    compileOutputChannel.appendLine(msg)
    if (show) {
      compileOutputChannel.show(true)
    }
  } else {
    logger(
      `Unable to output to Compile OutputChannel, ${msg}`,
      LogLevel.warning,
      true
    )
  }
}

const getPdfOutputPath = (filePath: string, additionalArgs: string[]) => {
  const fileDir = path.dirname(filePath)
  const defaultPdfPath = path.join(
    fileDir,
    `${path.basename(filePath, path.extname(filePath))}.pdf`
  )

  const outputArgIndex = additionalArgs.findIndex(
    (arg) => arg === `-o` || arg === `--output`
  )
  const joinedOutputArg = additionalArgs.find((arg) =>
    arg.startsWith(`--output=`)
  )
  const compactOutputArg = additionalArgs.find(
    (arg) => arg.startsWith(`-o`) && arg.length > 2
  )

  const outputArg =
    (outputArgIndex >= 0 ? additionalArgs[outputArgIndex + 1] : undefined) ??
    joinedOutputArg?.replace(/^--output=/, ``) ??
    compactOutputArg?.replace(/^-o/, ``)

  if (!outputArg) {
    return defaultPdfPath
  }

  const outputPath = path.isAbsolute(outputArg)
    ? outputArg
    : path.join(fileDir, outputArg)

  if (
    outputArg.endsWith(path.sep) ||
    (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory())
  ) {
    return path.join(outputPath, path.basename(defaultPdfPath))
  }

  if (path.extname(outputPath).toLocaleLowerCase() === `.pdf`) {
    return outputPath
  }

  return `${outputPath}.pdf`
}

const restoreFocusToDocument = async (
  textDocument: vscode.TextDocument,
  viewColumn: vscode.ViewColumn,
  selection?: vscode.Selection
) => {
  await vscode.window.showTextDocument(textDocument, {
    viewColumn,
    preserveFocus: false,
    preview: false,
    selection,
  })
}

const openPdf = async (
  pdfPath: string,
  mute: boolean,
  sourceDocument: vscode.TextDocument
) => {
  if (!fs.existsSync(pdfPath)) {
    logger(`PDF not found: ${pdfPath}`, LogLevel.warning, mute)
    outputToChannel(`PDF not found: ${pdfPath}`, !mute)
    return
  }

  try {
    const sourceEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.fsPath === sourceDocument.uri.fsPath
    )
    const sourceViewColumn =
      sourceEditor?.viewColumn ?? vscode.window.activeTextEditor?.viewColumn
    const sourceSelection =
      sourceEditor?.selection ?? vscode.window.activeTextEditor?.selection

    await vscode.commands.executeCommand(
      `vscode.open`,
      vscode.Uri.file(pdfPath),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
    )
    if (sourceViewColumn) {
      await restoreFocusToDocument(
        sourceDocument,
        sourceViewColumn,
        sourceSelection
      )
      setTimeout(
        () =>
          restoreFocusToDocument(
            sourceDocument,
            sourceViewColumn,
            sourceSelection
          ),
        100
      )
      setTimeout(
        () =>
          restoreFocusToDocument(
            sourceDocument,
            sourceViewColumn,
            sourceSelection
          ),
        500
      )
    }
    outputToChannel(`Opened PDF: ${pdfPath}`)
  } catch (err) {
    try {
      await vscode.env.openExternal(vscode.Uri.file(pdfPath))
      outputToChannel(`Opened PDF externally: ${pdfPath}`)
    } catch (externalErr) {
      logger(
        `Unable to open PDF: ${err}; external open also failed: ${externalErr}`,
        LogLevel.warning,
        mute
      )
      outputToChannel(`Unable to open PDF: ${externalErr}`, !mute)
    }
  }
}

const getCompilationFilePath = (
  compileMode: CompileMode,
  activeTextDocument: vscode.TextDocument
) => {
  const config = getConfiguration(activeTextDocument)
  // first, trivially check if the pathToMainCompilationFile is set
  if (config.compilation.pathToMainCompilationFile.trim().length > 0) {
    // now check if it's onSave and the setting is set to compileMainFileOnSave
    // or, if it's onCompile
    if (
      (compileMode === CompileMode.onSave &&
        config.compilation.compileMainFileOnSave) ||
      compileMode === CompileMode.onCompile
    ) {
      // get the "root" folder path of the current file
      const workspaceFolderPath = vscode.workspace.getWorkspaceFolder(
        activeTextDocument.uri
      )?.uri.fsPath
      if (workspaceFolderPath) {
        const compileFilePath = path.join(
          workspaceFolderPath,
          config.compilation.pathToMainCompilationFile.trim()
        )
        if (fs.existsSync(compileFilePath)) {
          return compileFilePath
        } else {
          throw new Error(
            `Unable to find main file to compile: file does not exist (${compileFilePath})`
          )
        }
      } else {
        throw new Error(
          `Unable to find main file to compile: unable to get workspace folder path of the currently active text document`
        )
      }
    }
  }

  // active document
  return activeTextDocument.uri.fsPath
}

// kill the compilation process
export const killCompilation = async (mute = false) => {
  if (compileProcess) {
    compileProcess.process.kill(`SIGKILL`)
    compileProcess = undefined
    logger(`Compilation process killed`, LogLevel.info, mute)
  } else {
    logger(`No active compilation process running`, LogLevel.info, mute)
  }
}

// process and show the error
export const processStderr = async (output: string) => {
  let errGroup: RegExpExecArray | null = null
  while ((errGroup = errMsgRegex.exec(output))) {
    const channelOutput = `${errGroup[4].toLocaleUpperCase()}: ${errGroup[0]}`
    outputToChannel(channelOutput, errGroup[4] === `error`)
  }
}

// compile
export const compile = async (
  compileMode = CompileMode.onCompile,
  mute = false,
  textDocument: vscode.TextDocument | undefined = undefined
) => {
  const compilingStatasBarItem = getCompilingStatusBarItem()
  compilingStatasBarItem.show()

  try {
    if (compileProcess) {
      killCompilation(true)
    }

    const binPath = getBinPath()

    const activeTextDocument =
      textDocument ?? vscode.window.activeTextEditor?.document
    if (!activeTextDocument) {
      throw new Error(`No active text editor open`)
    }

    const docLangId = activeTextDocument.languageId
    if (docLangId !== langId) {
      throw new Error(`Only Lilypond files are supported`)
    }

    const filePath = getCompilationFilePath(compileMode, activeTextDocument)

    const config = getConfiguration(activeTextDocument)
    const additionalArgs: string[] =
      config.compilation.additionalCommandLineArguments
        .trim()
        .split(/\s+/)
        .filter(Boolean)

    const args = [`--loglevel=WARNING`].concat(additionalArgs).concat(filePath)
    const pdfPath = getPdfOutputPath(filePath, additionalArgs)

    if (compileMode === CompileMode.onSave) {
      outputToChannel(`[SAVED]: ${textDocument?.uri.fsPath}`)
    }
    outputToChannel(`Compiling: ${filePath}`)
    logger(`Compiling...`, LogLevel.info, mute)
    compileProcess = {
      compileMode: compileMode,
      process: cp.spawn(binPath, args, { cwd: path.dirname(filePath) }),
    }

    compileProcess.process.stdout.on("data", (data) => {
      // logger(`stdout: ${data}`, LogLevel.info, true)
      outputToChannel(`${data.toString()}`)
    })

    compileProcess.process.stderr.on("data", (data) => {
      // logger(`Compilation Error: ${data}`, LogLevel.error, mute);
      outputToChannel(`${data.toString()}`)
      processStderr(data.toString())
    })

    compileProcess.process.on("close", (code) => {
      logger(
        `Compilation process exited with code ${code}`,
        LogLevel.info,
        true
      )
      if (code === 0) {
        logger(`Compilation successful`, LogLevel.info, mute)
        outputToChannel(`Compilation successful`)
        if (config.compilation.openPdfAfterCompilation !== false) {
          openPdf(pdfPath, mute, activeTextDocument)
        }
      } else if (code === null) {
        // here, the compilation process is replaced (i.e. killed above)
        logger(`Compilation killed`, LogLevel.error, mute)
        outputToChannel(`Compilation killed`, false)
      } else {
        logger(`Compilation failed`, LogLevel.error, mute)
        outputToChannel(`Compilation failed`)
        showCompilationFailedStatusBarItem()
      }
      compileProcess = undefined
      compilingStatasBarItem.hide()
    })
  } catch (err) {
    logger(String(err), LogLevel.error, mute)
    outputToChannel(`Compilation failed: ${err}`, true)
    showCompilationFailedStatusBarItem()
    compilingStatasBarItem.hide()
  }
}

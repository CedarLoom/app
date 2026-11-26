# Command line

`cedarloom` works on the project in the current folder. `cloom` is a short name for it. `cedarloom <command> --help` shows the usage of each command. In a clone of the app it is `node <clone>/packages/cli/bin/cedarloom.js`.

## Commands

| Command                                       | What it does                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `doctor`                                      | Checks the Node.js version, the project, the cl-workflow plugin and the workflow definitions. |
| `runs list`                                   | Lists the runs recorded for this project.                                                     |
| `runs show <run>`                             | Shows a run and its steps.                                                                    |
| `undo <run>`                                  | Undoes a run, as a run of its own.                                                            |
| `workflows list`                              | Lists the shipped and project workflow definitions.                                           |
| `workflows show <name>`                       | Shows a workflow definition.                                                                  |
| `workflows validate [<name>...]`              | Checks workflow definitions with the plugin's generator.                                      |
| `workflows generate [<name>...]`              | Writes the files of workflow definitions into `.claude`.                                      |
| `workflows new <name> [--from <shipped>]`     | Creates a project workflow from a shipped definition.                                         |
| `workflows add\|move\|remove\|set <name> ...` | Edits a project workflow and its files in `.claude`.                                          |
| `workflows off <id> \| --plugin`              | Switches a workflow, or the plugin, off for this project.                                     |
| `workflows on <id> \| --plugin`               | Switches back on what `workflows off` switched off.                                           |

## Plans and undo

A command that changes files shows its plan and stops. Add `--yes` to apply the plan as a run; `cedarloom undo <run>` reverts it as a new run.

```bash
cedarloom workflows new my-flow         # shows the plan: a copy of the shipped dev workflow
cedarloom workflows new my-flow --yes   # applies it as a run
cedarloom runs list
```

`add` inserts a stage or phase, given as JSON, at a JSON Pointer: `/stages/<i>` or `/stages/<i>/phases/<j>`, with `-` as the index for the end of the list. The plugin's generator checks the edited definition first; an edit it refuses is not saved.

## Options

| Option                | Effect                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `--json`              | Prints one JSON document instead of text.                                                |
| `--plugin-root <dir>` | Uses this cl-workflow folder instead of the installed plugin. Its origin is not checked. |
| `--help`, `-h`        | Shows the usage of a command.                                                            |
| `--version`, `-V`     | Prints the version of CedarLoom.                                                         |

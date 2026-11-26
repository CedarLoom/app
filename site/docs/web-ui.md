# Web UI

`cedarloom-app` starts a server for the project in the current folder on `127.0.0.1`, prints its URL with a one-time token and opens it in your default browser. The server runs until you interrupt it with Ctrl+C. In a clone of the app it is `node <clone>/packages/app/bin/cedarloom-app.js`.

```bash
cd my-project
cedarloom-app
```

## Views

| View      | Shows                                                                                   |
| --------- | --------------------------------------------------------------------------------------- |
| Doctor    | The checks of `cedarloom doctor`: Node.js, the project, the plugin and the definitions. |
| Runs      | The recorded runs and the steps of each.                                                |
| Workflows | The shipped and project workflow definitions, with the findings of their check.         |

## Options

| Option                | Effect                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `--port <n>`          | Listens on port `<n>`. `0`, the default, takes a free port.                              |
| `--no-open`           | Prints the URL without opening the browser.                                              |
| `--plugin-root <dir>` | Uses this cl-workflow folder instead of the installed plugin. Its origin is not checked. |
| `--json`              | Prints one JSON document instead of text.                                                |
| `--help`, `-h`        | Shows the usage.                                                                         |
| `--version`, `-V`     | Prints the version of `cedarloom-app`.                                                   |

The UI reaches only this local server. Open the printed link: the token in it is what lets your browser in.

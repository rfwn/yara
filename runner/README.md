# yara-runner

Lets Yara's agents read, build, edit and deploy a project folder on your machine. Every command and file write is printed in the terminal as it happens.

```sh
npx yara-runner --server https://<your-yara> --token yr_… --dir .
```

Get the token from Yara → Settings → Local runner.

| Flag | Default | |
| --- | --- | --- |
| `--server` | `$YARA_SERVER` or `http://localhost:3001` | Yara's URL |
| `--token` | `$YARA_RUNNER_TOKEN` | Runner token (required) |
| `--dir` | `.` | Folder to share; agents can't leave it |
| `--name` | hostname | Label shown in Yara |
| `--read-only` | off | Refuse writes and commands |

Requires Node.js 22 or newer.

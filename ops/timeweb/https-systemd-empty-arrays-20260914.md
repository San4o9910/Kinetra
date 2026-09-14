# Effective systemd property decoding, 2026-09-14

Diagnostic runs 34844684054 and 34844977251 stopped before any Caddy attempt.
All temporary keys and directories were cleaned; local application acceptance passed after the dynamic-response correction.

Primary source inspected: https://github.com/systemd/systemd/blob/v255/src/systemctl/systemctl-show.c
The EnvironmentFiles and Exec* structured-array printers iterate members and print no property line for an empty array, including with --all.
The previous parser incorrectly required every property name to be present in textual output.

For omitted EnvironmentFiles, ExecCondition, ExecStartPre, ExecStartPost, ExecStop and ExecStopPost only, the decoder now reads the exact service D-Bus property with busctl and requires the exact type signature and zero members.
It does not infer emptiness from omission. Unsupported properties, bus errors, nonempty/wrong-type arrays, missing scalar fields, missing ExecStart/ExecReload, unexpected or duplicate lines still fail.
All unit hash, owner, environment, drop-in, command, state, pending-job, process and one-use activation checks remain intact.
Five offline parser cases exercise actual omission and refusal cases before host execution.

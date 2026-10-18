# Changelog

## Unreleased

- Remove the global `context` guard: PBB no longer trims other tools' results or historical messages. Output limits belong to each tool, and Pi manages conversation context and dynamic tool declarations.
- Reuse Pi's public `truncateTail` and default limits for foreground, live, and background bash output. Keep complete trailing lines where possible and preserve UTF-8 boundaries for oversized final lines, instead of dropping batches of lines or slicing arbitrary bytes.
- Match native bash's limit semantics: the 2000-line / 50-KiB limit applies to the output body; the truncation notice is appended afterward. Full output remains accessible through the indicated log file or `pbb tail --full`.
- Escape closing `pi_context` tags only in background message envelopes, leaving foreground output literal.
- Keep PBB process-group/job management and the separate 1-MiB structured-output contract unchanged.
- Add regression coverage for exact output limits, line/byte overflow, Unicode, live/background output, full-log retrieval, and tool activation after a large codemode result without rewriting the provider request prefix.

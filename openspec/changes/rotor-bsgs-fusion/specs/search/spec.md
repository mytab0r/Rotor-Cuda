# Search modes

## Added requirements

### Requirement: explicit BSGS backend selection
The executable MUST expose BSGS as an explicit mode and MUST distinguish CPU and CUDA execution in startup and periodic statistics. Existing address/xpoint modes MUST remain selectable.

### Requirement: sequential recovery
Sequential BSGS MUST persist a checkpoint that identifies table/filter/range and current position. Restart MUST reject a mismatched or corrupted checkpoint instead of silently continuing.

### Requirement: random recovery safety
Random BSGS MUST NOT claim resumability until table identity and random-state restoration are tested. Until then, CLI MUST either disable random recovery or clearly mark it non-resumable.

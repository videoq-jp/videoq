# Scene splitting parity fixture

`python-scene-splitting.json` freezes outputs from the retired Python splitter.
The TypeScript tests continue to cover token boundaries, Unicode, ties and SRT
formatting against this independent reference after the Python implementation is
removed. Regenerate historical outputs only from commit `901b8b32`, using its
`apps/api/test/helpers/generate-python-scene-fixtures.py` and Python dependencies.
The production worker no longer ships a second scene splitter or tokenizer.

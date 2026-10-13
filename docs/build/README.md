# PDF build

`AI_Project_Presentation.pdf` in the parent directory is generated from
`presentation.html` here. `dashboard.png` is a real screenshot of the running
`/router` dashboard over the 155 logged requests — not a mockup.

To regenerate:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=../AI_Project_Presentation.pdf \
  --virtual-time-budget=12000 \
  "file://$PWD/presentation.html"
```

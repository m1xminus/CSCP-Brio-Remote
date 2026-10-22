# companion-module-calrec-brio

Bitfocus Companion module for the Calrec Brio (CSCP). See `companion/HELP.md` for what it does and how to use it.

`src/lib` is a copy of the protocol core from the CSCP Brio Remote app (`src/core`, `src/shared`).

```
npm install
npm test          # runs against a simulated desk (test/support/mockDesk.js)
npm run package   # builds the .tgz you import into Companion
```

Not yet tried in a real Companion or on a real Brio.

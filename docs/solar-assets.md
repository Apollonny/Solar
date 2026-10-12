# Solar visual asset provenance

- `solar-brand-reference.png`: the original brand board supplied by the user on 28 September 2026. It is the visual authority for the mark, wordmark and palette.
- `src/renderer/src/assets/solar-mark.png`: transparent mark isolated from that reference with the built-in image generation tool. Prompt: “Extract ONLY the large full-color orbital planet symbol in the upper-left panel; preserve silhouette, proportions, tilt, layering, gradients, edge highlights and central dark oval; remove text and background; center on transparent square.” The generated asset was visually compared with the reference.
- `src/renderer/src/components/BrandWordmark.tsx`: displays the original custom wordmark directly from the supplied board, with a CSS crop and screen blend on the dark canvas. An attempted generated extraction introduced noise and was not shipped.
- `build/icon.png`, `docs/logo.png`, `src/renderer/src/assets/logo.png`, `resources/solar-project-icon.png`: resized or composited derivatives of the selected transparent mark. The dark tile uses `build/solar-icon-base.svg`.
- `src/renderer/src/assets/fonts/Sora-Variable.ttf`: Sora variable font from the [Google Fonts repository](https://github.com/google/fonts/tree/main/ofl/sora), under the included `OFL.txt` license. It is used for display headings; the custom wordmark remains the user-supplied artwork.

---
description: Generate or edit raster images with GPT Image 2 for illustrations, photos, textures, sprites, mockups, banners, backgrounds, and other bitmap assets.
license: MIT
metadata:
  model: gpt-image-2
---

# Image generation

Use the image generation tool contributed by this extension when the user wants
a new raster image or wants to edit an existing image. Its runtime name ends in
`__imagegen` because Eve prefixes extension contributions with the mount name.

Do not substitute SVG, HTML, CSS, or a prose description when the requested
deliverable is a generated bitmap. Prefer deterministic code-native editing
when an existing SVG, icon system, or other editable source should be preserved.

## Workflow

1. Decide whether this is a new image or an edit/reference workflow.
2. Turn the request into a concise visual specification. Preserve exact text,
   constraints, and anything that must remain unchanged.
3. For a new image, call the tool with `prompt` only.
4. For an edit, first ensure every target/reference is available in the Eve
   sandbox. Attachments are staged there by Eve. Pass the relevant paths in
   `referenced_image_paths` and identify each image's role in the prompt.
5. Inspect the returned image. If it misses the request, make one targeted
   revision and pass the generated image's returned sandbox path as the first
   reference.
6. The tool saves its result under `/workspace/generated_images`. If the user
   named a project destination, copy the selected result there after generation
   without overwriting an existing asset unless replacement was explicit.

For multiple distinct assets or variants, make one tool call per asset. Keep
in-image text short, quote it exactly, and check every rendered word. State both
what should change and what must remain fixed during edits.

GPT Image 2 does not support transparent output. Do not promise a transparent
background; use an opaque background that can be removed later, or explain the
model limitation.

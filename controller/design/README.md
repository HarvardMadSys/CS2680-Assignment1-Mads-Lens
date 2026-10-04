# Realism study

The interface was art-directed through a 3D study rather than styled by eye.

`study.py` is a Blender 5.2 script (`blender --background --python study.py`) that models
the control surface as a physical object — anodised aluminium chassis, PBT keycaps, inset
black-glass readouts, a recessed emissive panel. It writes `render.png` next to itself;
`study.png` is the committed render, and the target the stylesheet is matched against.

The render's palette was measured rather than eyeballed, and those samples became the CSS
tokens: chassis `#272727`, keycap top face `#918F8D`, OLED glass `#777878`, screen field
`#363636`, accent in shadow `#B13300`, accent lit face `#F6896C`, brightest specular
`#F0F0EF`.

Two values in the stylesheet deliberately depart from the render:

- `--o` is `#E8551F`, between the accent's shadow and lit samples. Neither measured value
  is legible as small text on near-black.
- `--red` stays a true red. The study is monochrome plus one accent, but an errored tool
  call has to be separable from a pending one at a glance, and colour carries that before
  the glyph does.

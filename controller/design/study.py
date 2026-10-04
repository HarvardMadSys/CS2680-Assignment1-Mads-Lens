import bpy
import math
import os
import random
from mathutils import Vector

# ---------------------------------------------------------------------------
# CLAUDE CONTROLLER / STUDY 03
#
# Preserve the established envelope and layout. Concentrate on readable tonal
# steps, light crowns/dark skirts, machined edge lines, luminous display content,
# restrained glass falloff, and real shadow gaps.
#
# No compositor: no glare, streaks, star filters, or unsupported Mix nodes.
# ---------------------------------------------------------------------------

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
random.seed(501)

OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "render.png")
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 64
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.025
scene.cycles.use_denoising = True
scene.cycles.seed = 501

for prop, value in (
    ("adaptive_min_samples", 16),
    ("use_animated_seed", False),
    ("max_bounces", 7),
    ("diffuse_bounces", 2),
    ("glossy_bounces", 3),
    ("transmission_bounces", 4),
    ("transparent_max_bounces", 6),
    ("use_reflective_caustics", False),
    ("use_refractive_caustics", False),
    ("sample_clamp_indirect", 3.5),
):
    if hasattr(scene.cycles, prop):
        setattr(scene.cycles, prop, value)

try:
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
except (TypeError, ValueError):
    pass

scene.render.threads_mode = 'FIXED'
scene.render.threads = 18
scene.render.resolution_x = 1280
scene.render.resolution_y = 800
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.use_compositing = False
scene.render.use_sequencer = False

if hasattr(scene, "compositing_node_group"):
    scene.compositing_node_group = None

scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.image_settings.color_depth = '8'
scene.render.image_settings.compression = 15
scene.render.filepath = OUTPUT

for transform in ('AgX', 'Filmic'):
    try:
        scene.view_settings.view_transform = transform
        break
    except (TypeError, ValueError):
        pass

try:
    scene.view_settings.look = 'AgX - Medium High Contrast'
except (TypeError, ValueError):
    pass

scene.view_settings.exposure = -0.40
scene.view_settings.gamma = 1.0
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0

# ---------------------------------------------------------------------------
# Materials: all structural colours remain neutral, near-black anodised metal.
# Microtexture is intentionally subservient to broad, CSS-translatable tones.
# ---------------------------------------------------------------------------

def gray(value):
    return (value, value, value)


def set_socket(node, name, value):
    socket = node.inputs.get(name)
    if socket is not None:
        socket.default_value = value


def material(name, color, metallic=0.0, roughness=0.45,
             emission=None, strength=0.0, coat=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1.0)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    set_socket(bsdf, "Base Color", (*color, 1.0))
    set_socket(bsdf, "Metallic", metallic)
    set_socket(bsdf, "Roughness", roughness)
    set_socket(bsdf, "IOR", 1.46)
    set_socket(bsdf, "Coat Weight", coat)
    set_socket(bsdf, "Coat Roughness", 0.26)
    if emission is not None:
        set_socket(bsdf, "Emission Color", (*emission, 1.0))
        set_socket(bsdf, "Emission Strength", strength)
    return mat


def anodised(name, value, roughness=0.36, metallic=0.94,
             grain_direction=(115.0, 11000.0, 4200.0)):
    mat = material(name, gray(value), metallic=metallic, roughness=roughness)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    set_socket(bsdf, "Anisotropic IOR Level", 0.22)

    position = nodes.new("ShaderNodeNewGeometry")
    stretch = nodes.new("ShaderNodeVectorMath")
    stretch.operation = 'MULTIPLY'
    stretch.inputs[1].default_value = grain_direction
    links.new(position.outputs["Position"], stretch.inputs[0])

    brush = nodes.new("ShaderNodeTexNoise")
    brush.inputs["Scale"].default_value = 1.0
    brush.inputs["Detail"].default_value = 2.0
    brush.inputs["Roughness"].default_value = 0.55
    links.new(stretch.outputs["Vector"], brush.inputs["Vector"])

    blast = nodes.new("ShaderNodeTexNoise")
    blast.inputs["Scale"].default_value = 26000.0
    blast.inputs["Detail"].default_value = 2.0
    links.new(position.outputs["Position"], blast.inputs["Vector"])

    color = nodes.new("ShaderNodeValToRGB")
    color.color_ramp.elements[0].position = 0.15
    color.color_ramp.elements[0].color = (*gray(value * 0.98), 1.0)
    color.color_ramp.elements[1].position = 0.85
    color.color_ramp.elements[1].color = (*gray(value * 1.02), 1.0)
    links.new(brush.outputs["Fac"], color.inputs["Fac"])
    links.new(color.outputs["Color"], bsdf.inputs["Base Color"])

    rough = nodes.new("ShaderNodeMapRange")
    rough.inputs["To Min"].default_value = roughness - 0.025
    rough.inputs["To Max"].default_value = roughness + 0.025
    links.new(blast.outputs["Fac"], rough.inputs["Value"])
    links.new(rough.outputs["Result"], bsdf.inputs["Roughness"])

    brush_bump = nodes.new("ShaderNodeBump")
    brush_bump.inputs["Strength"].default_value = 0.12
    brush_bump.inputs["Distance"].default_value = 0.000006
    links.new(brush.outputs["Fac"], brush_bump.inputs["Height"])

    blast_bump = nodes.new("ShaderNodeBump")
    blast_bump.inputs["Strength"].default_value = 0.14
    blast_bump.inputs["Distance"].default_value = 0.000009
    links.new(blast.outputs["Fac"], blast_bump.inputs["Height"])
    links.new(brush_bump.outputs["Normal"], blast_bump.inputs["Normal"])
    links.new(blast_bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def pbt(name, color, roughness=0.46, emission=None, strength=0.0):
    mat = material(name, color, roughness=roughness,
                   emission=emission, strength=strength)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    position = nodes.new("ShaderNodeNewGeometry")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 20000.0
    noise.inputs["Detail"].default_value = 2.0
    links.new(position.outputs["Position"], noise.inputs["Vector"])

    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.16
    bump.inputs["Distance"].default_value = 0.000008
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"],
              nodes.get("Principled BSDF").inputs["Normal"])
    return mat


chassis_mat = anodised("Black anodised CNC shell", 0.055, 0.34)
deck_mat = anodised("Black bead-blasted recessed deck", 0.047, 0.39)
bottom_mat = anodised("Black aluminium bottom plate", 0.040, 0.43)
module_mat = anodised("Readable satin-black module carriers", 0.040, 0.40, 0.86)
bezel_mat = anodised("Machined pocket chamfers", 0.052, 0.29)
knob_mat = anodised("Encoder black machined aluminium", 0.063, 0.32)
rail_mat = anodised(
    "Longitudinal milled side rails", 0.065, 0.30, 0.96,
    grain_direction=(12000.0, 115.0, 4200.0)
)
grille_mat = anodised("Satin-black perforated sheet", 0.046, 0.42, 0.90)
fastener_mat = material("Blackened stainless fasteners", gray(0.075), 0.94, 0.25)

gap_mat = material("Deep reveal / black elastomer", gray(0.0012), roughness=0.88)
rubber_mat = material("Anti-slip silicone", gray(0.005), roughness=0.86)

key_mat = pbt("Warm light-grey PBT crown", (0.58, 0.565, 0.535), 0.44)
key_side_mat = pbt("Dark PBT skirt", (0.27, 0.260, 0.242), 0.49)
ink_mat = material("Charcoal dye-sub legends", gray(0.007), roughness=0.74)
silk_mat = material("Light grey laser legends", gray(0.60), roughness=0.67)
silk_dim_mat = material("Secondary grey laser legends", gray(0.35), roughness=0.70)

orange_key_mat = pbt(
    "Flat orange illuminated run crown",
    (0.90, 0.075, 0.003), 0.49,
    emission=(1.0, 0.070, 0.0018), strength=1.15
)
orange_skirt_mat = pbt(
    "Dark orange run skirt",
    (0.43, 0.020, 0.001), 0.49,
    emission=(0.85, 0.035, 0.001), strength=0.22
)
orange_pixel = material(
    "Orange OLED label emission", (0.10, 0.006, 0.0003), roughness=0.95,
    emission=(1.0, 0.075, 0.002), strength=2.9
)
orange_lens_mat = material(
    "Orange opal status lens", (0.35, 0.023, 0.001), roughness=0.25,
    emission=(1.0, 0.070, 0.002), strength=3.8, coat=0.30
)
run_legend_mat = material(
    "White run legend", gray(0.72), roughness=0.65,
    emission=gray(0.9), strength=1.65
)

screen_mat = material(
    "IPS luminous charcoal / subtle vertical falloff",
    gray(0.0012), roughness=0.96,
    emission=gray(0.030), strength=1.6
)
# A simple luminance gradient rather than noisy surface texture.
nodes, links = screen_mat.node_tree.nodes, screen_mat.node_tree.links
coordinates = nodes.new("ShaderNodeTexCoord")
separate = nodes.new("ShaderNodeSeparateXYZ")
ramp = nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (*gray(0.023), 1.0)
ramp.color_ramp.elements[1].color = (*gray(0.039), 1.0)
links.new(coordinates.outputs["Generated"], separate.inputs["Vector"])
links.new(separate.outputs["Y"], ramp.inputs["Fac"])
links.new(ramp.outputs["Color"],
          nodes.get("Principled BSDF").inputs["Emission Color"])

oled_black_mat = material(
    "OLED true black surround", gray(0.0005), roughness=0.98,
    emission=gray(0.0005), strength=0.5
)
card_mat = material(
    "IPS card luminance step", gray(0.001), roughness=0.98,
    emission=gray(0.066), strength=1.0
)
code_mat = material(
    "IPS black code well", gray(0.0005), roughness=0.98,
    emission=gray(0.010), strength=1.0
)
pixel_white = material(
    "IPS crisp white pixels", gray(0.08), roughness=0.98,
    emission=gray(0.90), strength=4.0
)
pixel_mid = material(
    "IPS secondary pixels", gray(0.03), roughness=0.98,
    emission=gray(0.40), strength=2.9
)
pixel_dim = material(
    "IPS tertiary pixels", gray(0.005), roughness=0.98,
    emission=gray(0.15), strength=1.8
)
pixel_line = material(
    "IPS structural rules", gray(0.001), roughness=0.98,
    emission=gray(0.065), strength=1.4
)
oled_white = material(
    "OLED large numeric emission", gray(0.10), roughness=0.98,
    emission=gray(0.95), strength=4.8
)

glass_mat = material("Clean low-reflection cover glass", gray(0.99), roughness=0.022)
glass_bsdf = glass_mat.node_tree.nodes.get("Principled BSDF")
set_socket(glass_bsdf, "Transmission Weight", 1.0)
set_socket(glass_bsdf, "IOR", 1.42)
set_socket(glass_bsdf, "Specular IOR Level", 0.20)

floor_mat = material("Dark charcoal seamless", gray(0.0035), roughness=0.87)
set_socket(floor_mat.node_tree.nodes.get("Principled BSDF"),
           "Specular IOR Level", 0.20)

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

text_fits = []


def mesh_object(name, vertices, faces, mat=None):
    mesh = bpy.data.meshes.new(name + " mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    if mat is not None:
        mesh.materials.append(mat)
    return obj


def rounded_points(w, h, radius, steps=12):
    radius = min(radius, w * 0.499, h * 0.499)
    result = []
    corners = (
        (w / 2 - radius, h / 2 - radius, 0),
        (-w / 2 + radius, h / 2 - radius, 90),
        (-w / 2 + radius, -h / 2 + radius, 180),
        (w / 2 - radius, -h / 2 + radius, 270),
    )
    for cx, cy, start in corners:
        for i in range(steps + 1):
            a = math.radians(start + 90 * i / steps)
            result.append((cx + radius * math.cos(a),
                           cy + radius * math.sin(a)))
    return result


def bevel(obj, width, segments=3):
    if width <= 0:
        return
    mod = obj.modifiers.new("Fine manufactured edge break", 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(35)
    if hasattr(mod, "harden_normals"):
        mod.harden_normals = True
    try:
        normals = obj.modifiers.new("Weighted surface normals", 'WEIGHTED_NORMAL')
        normals.keep_sharp = True
        normals.weight = 40
    except (RuntimeError, TypeError):
        pass


def rounded_prism(name, x, y, z, w, h, depth, radius, mat,
                  edge=0.0, steps=12):
    points = rounded_points(w, h, radius, steps)
    n = len(points)
    verts = (
        [(px, py, -depth / 2) for px, py in points] +
        [(px, py, depth / 2) for px, py in points]
    )
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    obj = mesh_object(name, verts, faces, mat)
    obj.location = (x, y, z)
    for polygon in obj.data.polygons:
        polygon.use_smooth = len(polygon.vertices) == 4
    bevel(obj, edge)
    return obj


def cylinder(name, x, y, z, radius, depth, mat=None,
             vertices=64, edge=0.0):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=(x, y, z)
    )
    obj = bpy.context.object
    obj.name = name
    if mat is not None:
        obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = len(polygon.vertices) == 4
    bevel(obj, edge)
    return obj


def subtract_objects(obj, cutters, name):
    if not cutters:
        return
    bpy.ops.object.select_all(action='DESELECT')
    for cutter in cutters:
        cutter.select_set(True)
    bpy.context.view_layer.objects.active = cutters[0]
    if len(cutters) > 1:
        bpy.ops.object.join()
    cutter = bpy.context.view_layer.objects.active

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new(name, 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def pockets(obj, specifications, name):
    cutters = [
        rounded_prism(name + " cutter", x, y, 0.023,
                      w, h, 0.014, radius, None, steps=10)
        for x, y, w, h, radius in specifications
    ]
    subtract_objects(obj, cutters, name)


def label(name, body, x, y, z, size, mat, align='LEFT',
          max_width=None, rotation=None):
    curve = bpy.data.curves.new(name + " font", 'FONT')
    curve.body = body
    curve.size = size
    curve.align_x = align
    curve.align_y = 'CENTER'
    curve.space_character = 1.04
    curve.resolution_u = 2
    curve.extrude = 0.0
    curve.bevel_depth = 0.0
    curve.offset = 0.000014
    obj = bpy.data.objects.new(name, curve)
    scene.collection.objects.link(obj)
    obj.location = (x, y, z)
    if rotation is not None:
        obj.rotation_euler = rotation
    curve.materials.append(mat)
    if max_width:
        text_fits.append((obj, max_width))
    return obj


def flat_line(name, a, b, width, z, mat):
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = max(math.hypot(dx, dy), 1e-9)
    px, py = -dy / length * width / 2, dx / length * width / 2
    verts = [
        (a[0] - px, a[1] - py, z),
        (b[0] - px, b[1] - py, z),
        (b[0] + px, b[1] + py, z),
        (a[0] + px, a[1] + py, z),
    ]
    return mesh_object(name, verts, [(0, 1, 2, 3)], mat)


def flat_ring(name, x, y, radius, width, z, mat, segments=96):
    verts = []
    for r in (radius - width / 2, radius + width / 2):
        for i in range(segments):
            a = 2 * math.pi * i / segments
            verts.append((x + r * math.cos(a), y + r * math.sin(a), z))
    faces = []
    for i in range(segments):
        j = (i + 1) % segments
        faces.append((i, segments + i, segments + j, j))
    return mesh_object(name, verts, faces, mat)


def flat_disc(name, x, y, radius, z, mat, segments=32):
    verts = [
        (x + radius * math.cos(2 * math.pi * i / segments),
         y + radius * math.sin(2 * math.pi * i / segments), z)
        for i in range(segments)
    ]
    return mesh_object(name, verts, [tuple(range(segments))], mat)


def stepped_ring(name, x, y, profiles, mat, steps=14):
    n = len(rounded_points(profiles[0][0], profiles[0][1],
                           profiles[0][2], steps))
    verts = []
    for w, h, radius, z in profiles:
        verts.extend((px + x, py + y, z)
                     for px, py in rounded_points(w, h, radius, steps))
    faces = []
    for k in range(len(profiles) - 1):
        for i in range(n):
            j = (i + 1) % n
            faces.append((k * n + i, k * n + j,
                          (k + 1) * n + j, (k + 1) * n + i))
    return mesh_object(name, verts, faces, mat)


DECK = 0.0220
PANEL = 0.02165
UI = 0.02096
GLASS_TOP = 0.02170


def install_screen(name, x, y, w, h, radius=0.0016, oled=False):
    rounded_prism(
        name + " deep black gasket", x, y, 0.02008,
        w - 0.00022, h - 0.00022, 0.00125, radius, gap_mat
    )
    rounded_prism(
        name + " emissive image plane", x, y, UI - 0.00009,
        w - 0.0011, h - 0.0011, 0.00010,
        max(0.00030, radius - 0.0004),
        oled_black_mat if oled else screen_mat
    )
    rounded_prism(
        name + " clean cover glass", x, y, GLASS_TOP - 0.00020,
        w - 0.00150, h - 0.00150, 0.00040,
        max(0.00030, radius - 0.0005), glass_mat, edge=0.000045
    )
    stepped_ring(
        name + " machined reveal", x, y,
        [
            (w - 0.00010, h - 0.00010, radius, 0.02189),
            (w - 0.00042, h - 0.00042,
             max(0.00025, radius - 0.00016), 0.02168),
            (w - 0.00042, h - 0.00042,
             max(0.00025, radius - 0.00016), 0.02038),
        ],
        bezel_mat
    )


def keycap(name, x, y, w, h, legend, orange=False, size=0.0030):
    rounded_prism(
        name + " switch well", x, y, PANEL + 0.00002,
        w + 0.00070, h + 0.00070, 0.0007,
        0.00140, gap_mat, edge=0.00008
    )
    top = 0.02555 if orange else 0.02485
    base = PANEL + 0.00012
    radius = min(0.00138, h * 0.19)
    side_mat = orange_skirt_mat if orange else key_side_mat
    face_mat = orange_key_mat if orange else key_mat

    # A definite dark skirt, a narrow lit shoulder, and a very shallow dish.
    sections = [
        (w - 0.00040, h - 0.00040, radius, base),
        (w, h, radius, base + 0.00040),
        (w - 0.00022, h - 0.00022, radius, top - 0.00050),
        (w - 0.00045, h - 0.00045, radius * 0.94, top - 0.00016),
        (w - 0.00105, h - 0.00105, radius * 0.78, top),
    ]
    inner_w, inner_h = w - 0.00105, h - 0.00105
    dish = 0.00018
    for scale in (0.78, 0.48, 0.18):
        sections.append((
            inner_w * scale, inner_h * scale, radius * 0.78 * scale,
            top - dish * (1.0 - scale * scale)
        ))

    n = len(rounded_points(w, h, radius, 8))
    verts = []
    for sw, sh, sr, sz in sections:
        verts.extend((px + x, py + y, sz)
                     for px, py in rounded_points(sw, sh, sr, 8))
    faces = [tuple(reversed(range(n)))]
    indices = [0]
    for k in range(len(sections) - 1):
        for i in range(n):
            j = (i + 1) % n
            faces.append((k * n + i, k * n + j,
                          (k + 1) * n + j, (k + 1) * n + i))
            indices.append(0 if k < 2 else 1)

    center = len(verts)
    verts.append((x, y, top - dish))
    last = (len(sections) - 1) * n
    for i in range(n):
        faces.append((last + i, last + (i + 1) % n, center))
        indices.append(1)

    obj = mesh_object(name + " dished cap", verts, faces, side_mat)
    obj.data.materials.append(face_mat)
    for poly, index in zip(obj.data.polygons, indices):
        poly.material_index = index
        poly.use_smooth = poly.index != 0

    label(
        name + " legend", legend, x, y, top - 0.000018,
        size, run_legend_mat if orange else ink_mat,
        align='CENTER', max_width=w * 0.80
    )
    return obj

# ---------------------------------------------------------------------------
# Chassis, unchanged plan dimensions and module layout.
# ---------------------------------------------------------------------------

W, D = 0.450, 0.282

rounded_prism(
    "Black aluminium bottom", 0, 0, 0.00480,
    W - 0.0012, D - 0.0012, 0.0031, 0.0060,
    bottom_mat, edge=0.00025, steps=18
)
rounded_prism(
    "Perimeter assembly shadow seam", 0, 0, 0.00636,
    W - 0.0008, D - 0.0008, 0.00036, 0.0060,
    gap_mat, edge=0.00006, steps=18
)

profiles = [
    (W - 0.0015, D - 0.0015, 0.0056, 0.00655),
    (W, D, 0.0062, 0.00710),
    (W, D, 0.0062, 0.02235),
    (W - 0.0012, D - 0.0012, 0.0056, 0.02300),
    (0.4384, 0.2704, 0.0039, 0.02300),
    (0.4376, 0.2696, 0.0035, 0.02225),
    (0.4376, 0.2696, 0.0035, 0.01000),
]
n = len(rounded_points(W, D, 0.0062, 20))
verts = []
for w, h, radius, z in profiles:
    verts.extend((x, y, z) for x, y in rounded_points(w, h, radius, 20))
faces = [tuple(reversed(range(n)))]
for k in range(len(profiles) - 1):
    for i in range(n):
        j = (i + 1) % n
        faces.append((k * n + i, k * n + j,
                      (k + 1) * n + j, (k + 1) * n + i))
faces.append(tuple(range((len(profiles) - 1) * n, len(profiles) * n)))
body = mesh_object("CNC black aluminium shell", verts, faces, chassis_mat)

for x in (-0.174, 0.174):
    for y in (-0.104, 0.104):
        rounded_prism(
            "Rubberised low foot", x, y, 0.00185,
            0.038, 0.017, 0.0037, 0.006, rubber_mat, edge=0.0005
        )

deck = rounded_prism(
    "Continuous recessed black deck", 0, 0, DECK - 0.0015,
    0.4370, 0.2690, 0.003, 0.0035, deck_mat, steps=16
)

regions = {
    "rail": (0.0000, 0.1130, 0.4230, 0.0290, 0.0022),
    "router": (-0.1715, 0.0670, 0.0780, 0.0480, 0.0018),
    "agents": (-0.1715, 0.0210, 0.0780, 0.0360, 0.0018),
    "capabilities": (-0.1715, -0.0180, 0.0780, 0.0340, 0.0018),
    "instructions": (-0.1715, -0.0540, 0.0780, 0.0300, 0.0018),
    "version": (-0.1715, -0.0860, 0.0780, 0.0260, 0.0018),
    "trajectory": (0.0035, -0.0040, 0.2580, 0.1900, 0.0020),
    "scope": (0.1755, 0.0505, 0.0720, 0.0810, 0.0018),
    "outline": (0.1755, -0.0465, 0.0720, 0.1050, 0.0018),
    "prompt": (0.0000, -0.1190, 0.4230, 0.0250, 0.0020),
}
pockets(deck, list(regions.values()), "CNC deck pockets")
bevel(deck, 0.00015)

carriers = {}
for name in ("rail", "router", "agents", "capabilities",
             "instructions", "version", "prompt"):
    x, y, w, h, radius = regions[name]
    rounded_prism(
        name + " seam bed", x, y, PANEL - 0.00130,
        w - 0.00015, h - 0.00015, 0.0010, radius, gap_mat
    )
    carriers[name] = rounded_prism(
        name + " inset carrier", x, y, PANEL - 0.00085,
        w - 0.00085, h - 0.00085, 0.0017,
        radius - 0.0002, module_mat
    )

for name in ("trajectory", "scope", "outline"):
    install_screen(name, *regions[name])

# Four real countersunk, slotted fasteners.
screw_positions = [
    (-0.2188, -0.1341), (0.2188, -0.1341),
    (-0.2188, 0.1341), (0.2188, 0.1341),
]
cutters = [
    cylinder("Fastener seat cutter", x, y, 0.02275, 0.00190, 0.0021)
    for x, y in screw_positions
]

# Physical front-fascia grille pocket, outside all existing layout regions.
grille_cutter = rounded_prism(
    "Micro-grille pocket cutter", 0.132, -0.138, 0.0143,
    0.074, 0.0080, 0.018, 0.0010, None
)
grille_cutter.rotation_euler.x = math.pi / 2
cutters.append(grille_cutter)
subtract_objects(body, cutters, "Fastener and micro-grille machining")

for index, (x, y) in enumerate(screw_positions):
    cylinder("Dark fastener seat %d" % index, x, y, 0.02236,
             0.00187, 0.00045, gap_mat)
    count = 64
    sv, sf = [], []
    for radius, z in ((0.00188, 0.02299), (0.00148, 0.02262)):
        for i in range(count):
            a = 2 * math.pi * i / count
            sv.append((x + radius * math.cos(a), y + radius * math.sin(a), z))
    for i in range(count):
        j = (i + 1) % count
        sf.append((i, j, count + j, count + i))
    mesh_object("Countersink %d" % index, sv, sf, fastener_mat)

    head = cylinder("Micro-fastener %d" % index, x, y, 0.02279,
                    0.00146, 0.00058, fastener_mat)
    slot = rounded_prism(
        "Slotted head cutter", x, y, 0.02312,
        0.00208, 0.00038, 0.00072, 0.00014, None, steps=6
    )
    slot.rotation_euler.z = 0.30 + index * 0.51
    subtract_objects(head, [slot], "Real screwdriver slot")
    bevel(head, 0.000055)
    cylinder("Slot floor %d" % index, x, y, 0.02271,
             0.00130, 0.000045, gap_mat, vertices=48)

# ---------------------------------------------------------------------------
# Machined side rails: slim extrusions with a genuine longitudinal recess.
# ---------------------------------------------------------------------------

for side in (-1, 1):
    rail = rounded_prism(
        "Milled side rail %s" % side,
        side * 0.22515, 0, 0.0140,
        0.0027, 0.244, 0.0090, 0.0010, rail_mat, steps=12
    )
    groove = rounded_prism(
        "Side rail channel cutter",
        side * 0.22635, 0, 0.0137,
        0.0018, 0.217, 0.00065, 0.00025, None, steps=8
    )
    subtract_objects(rail, [groove], "Longitudinal milled channel")
    bevel(rail, 0.00018)
    rounded_prism(
        "Dark channel bed %s" % side,
        side * 0.22549, 0, 0.0137,
        0.00013, 0.216, 0.00043, 0.00006, bottom_mat
    )

# ---------------------------------------------------------------------------
# Real perforated micro-grille: 126 apertures, bevelled mouths and dark depth.
# The visual vocabulary is a simple dot matrix, not a raytracing-only effect.
# ---------------------------------------------------------------------------

back = rounded_prism(
    "Micro-grille dark backing", 0.132, -0.1388, 0.0143,
    0.073, 0.0074, 0.0004, 0.0009, gap_mat
)
back.rotation_euler.x = math.pi / 2

cols, rows, pitch, segments = 42, 3, 0.00155, 16
gv, gf, gi = [], [], []
for row in range(rows):
    for col in range(cols):
        cx = (col - (cols - 1) / 2) * pitch
        cy = (row - (rows - 1) / 2) * pitch
        start = len(gv)

        # Cell perimeter, chamfer mouth, bore shoulder, bore rear.
        for ring_index in range(4):
            for i in range(segments):
                a = 2 * math.pi * i / segments
                ca, sa = math.cos(a), math.sin(a)
                if ring_index == 0:
                    radius = (pitch / 2) / max(abs(ca), abs(sa))
                    z = 0.00014
                elif ring_index == 1:
                    radius, z = 0.00043, 0.00014
                elif ring_index == 2:
                    radius, z = 0.00037, 0.00007
                else:
                    radius, z = 0.00037, -0.00014
                gv.append((cx + radius * ca, cy + radius * sa, z))

        for ring_index in range(3):
            for i in range(segments):
                j = (i + 1) % segments
                a = start + ring_index * segments
                b = a + segments
                gf.append((a + i, a + j, b + j, b + i))
                gi.append(0 if ring_index == 0 else (1 if ring_index == 1 else 2))

grille = mesh_object("Perforated micro-grille / 126 real holes", gv, gf, grille_mat)
grille.data.materials.append(bezel_mat)
grille.data.materials.append(gap_mat)
for poly, index in zip(grille.data.polygons, gi):
    poly.material_index = index
grille.location = (0.132, -0.14065, 0.0143)
grille.rotation_euler.x = math.pi / 2

frame = stepped_ring(
    "Micro-grille inset frame", 0, 0,
    [
        (0.0732, 0.0073, 0.00090, 0.00008),
        (cols * pitch, rows * pitch, 0.00001, 0.00008),
        (cols * pitch, rows * pitch, 0.00001, -0.00020),
    ],
    grille_mat
)
frame.location = (0.132, -0.14065, 0.0143)
frame.rotation_euler.x = math.pi / 2

label("Front fascia identity", "claude controller", -0.195, -0.14104,
      0.014, 0.0030, silk_dim_mat, rotation=(math.pi / 2, 0, 0))

# ---------------------------------------------------------------------------
# Readout rail: larger numeral anchors, restrained orange labels, black glass.
# ---------------------------------------------------------------------------

oleds = [
    (-0.0670, 0.0310, "cost", "$0.3268", 0.0078),
    (-0.0320, 0.0320, "time", "68.7s", 0.0090),
    (0.0000, 0.0250, "turns", "3", 0.0106),
    (0.0290, 0.0250, "calls", "14", 0.0106),
    (0.0745, 0.0580, "route", "sonnet / high", 0.0054),
]
pockets(
    carriers["rail"],
    [(x, 0.113, w, 0.0210, 0.0012) for x, w, _, _, _ in oleds],
    "OLED sockets"
)
bevel(carriers["rail"], 0.00010)

rounded_prism(
    "Identity mark", -0.2045, 0.114, PANEL + 0.00005,
    0.0050, 0.0050, 0.00010, 0.0010, gap_mat, edge=0.00003
)
flat_disc("Identity centre", -0.2045, 0.114, 0.00065,
          PANEL + 0.00012, silk_mat)
label("Product name", "claude controller", -0.1985, 0.1158,
      PANEL + 0.00004, 0.0048, silk_mat, max_width=0.105)
label("Product descriptor", "agent control surface", -0.1985, 0.1090,
      PANEL + 0.00004, 0.0025, silk_dim_mat)

for x, w, title, value, size in oleds:
    install_screen("OLED " + title, x, 0.113, w, 0.0210, 0.0012, oled=True)
    label("OLED label " + title, title, x - w / 2 + 0.0027, 0.1193,
          UI, 0.00235, orange_pixel)
    label("OLED numeral " + title, value, x - w / 2 + 0.0027, 0.1098,
          UI, size, oled_white, max_width=w - 0.0053)

cylinder("Indicator retaining ring", 0.1158, 0.1143,
         PANEL + 0.00013, 0.00205, 0.0006, fastener_mat, edge=0.00010)
bpy.ops.mesh.primitive_uv_sphere_add(
    segments=32, ring_count=16, radius=1,
    location=(0.1158, 0.1143, PANEL + 0.00024)
)
lens = bpy.context.object
lens.name = "Orange opal status lens"
lens.scale = (0.00148, 0.00148, 0.00078)
lens.data.materials.append(orange_lens_mat)
for poly in lens.data.polygons:
    poly.use_smooth = True

label("Run state", "done", 0.1158, 0.1050, PANEL + 0.00005,
      0.0021, silk_dim_mat, align='CENTER')
label("Session", "sid 98d0e781", 0.143, 0.1237, PANEL + 0.00005,
      0.0020, silk_dim_mat)

for name, x, w, text in (
    ("VCS branches", 0.142, 0.0125, "git"),
    ("VCS history", 0.159, 0.0125, "log"),
    ("New session", 0.176, 0.0125, "+"),
    ("Expand", 0.197, 0.0170, "[ ]"),
):
    keycap(name, x, 0.113, w, 0.0112, text, size=0.0030)

# ---------------------------------------------------------------------------
# Left rack: readable headers and fields, consistent model-key gaps.
# ---------------------------------------------------------------------------

def module_header(region, title, tag=None):
    x, y, w, h, _ = regions[region]
    yy = y + h / 2 - 0.0063
    label(region + " header", title, x - w / 2 + 0.0043, yy,
          PANEL + 0.00006, 0.00375, silk_mat)
    if tag:
        label(region + " tag", tag, x + w / 2 - 0.0043, yy,
              PANEL + 0.00006, 0.0022, silk_dim_mat, align='RIGHT')
    flat_line(
        region + " divider",
        (x - w / 2 + 0.004, yy - 0.004),
        (x + w / 2 - 0.004, yy - 0.004),
        0.00014, PANEL + 0.00006, silk_dim_mat
    )


module_header("router", "router", "sonnet")
module_header("agents", "agents", "0 custom")
module_header("capabilities", "capabilities", "29 tools")
module_header("instructions", "instructions", "off")
module_header("version", "version control")

kx, ky = -0.1950, 0.0630
cylinder("Encoder anti-slip ring", kx, ky, 0.0220,
         0.01075, 0.0010, rubber_mat, edge=0.00012)
cylinder("Encoder shaft", kx, ky, 0.0231, 0.0043, 0.0020, fastener_mat)

flutes = 96
count = flutes * 4
knurl_profiles = [
    (0.02235, 0.00910), (0.02280, 0.00955),
    (0.02775, 0.00955), (0.02820, 0.00912),
]
verts = []
for z, radius in knurl_profiles:
    for i in range(count):
        a = 2 * math.pi * i / count
        tooth = 0.00013 * (0.5 + 0.5 * math.cos(2 * math.pi * i / 4))
        radius_i = radius + tooth
        verts.append((kx + radius_i * math.cos(a),
                      ky + radius_i * math.sin(a), z))
faces = [tuple(reversed(range(count)))]
for k in range(len(knurl_profiles) - 1):
    for i in range(count):
        j = (i + 1) % count
        faces.append((k * count + i, k * count + j,
                      (k + 1) * count + j, (k + 1) * count + i))
faces.append(tuple(range((len(knurl_profiles) - 1) * count,
                         len(knurl_profiles) * count)))
mesh_object("Encoder / 96 real knurls", verts, faces, knob_mat)
cylinder("Chamfered encoder crown", kx, ky, 0.02835, 0.00902, 0.00065,
         knob_mat, vertices=128, edge=0.00018)
rounded_prism("Encoder index", kx, ky + 0.0062, 0.028687,
              0.00065, 0.0030, 0.000015, 0.0002, silk_mat)

for degrees in (35, 62.5, 90, 117.5, 145):
    a = math.radians(degrees)
    flat_line(
        "Effort tick",
        (kx + 0.0117 * math.cos(a), ky + 0.0117 * math.sin(a)),
        (kx + 0.0126 * math.cos(a), ky + 0.0126 * math.sin(a)),
        0.00024, PANEL + 0.00007, silk_dim_mat
    )

label("Effort label", "effort", kx, 0.0499, PANEL + 0.00005,
      0.00215, silk_dim_mat, align='CENTER')
label("Effort value", "high", kx, 0.0463, PANEL + 0.00005,
      0.0026, silk_mat, align='CENTER')
label("Model label", "model", -0.1794, 0.0745, PANEL + 0.00005,
      0.0022, silk_dim_mat)

# 1.25 mm cap-to-cap gaps in both axes.
for x, y, text in (
    (-0.1685, 0.0660, "opus"), (-0.1450, 0.0660, "sonnet"),
    (-0.1685, 0.0570, "haiku"), (-0.1450, 0.0570, "fable"),
):
    keycap("Model " + text, x, y, 0.02225, 0.00775, text, size=0.0031)

flat_line("Selected model underline", (-0.1500, 0.0639), (-0.1400, 0.0639),
          0.00024, 0.02485, ink_mat)

fields = {
    "router": (-0.1560, 0.0476, 0.0425, 0.0062, 0.0008),
    "agents": (-0.1715, 0.0188, 0.0640, 0.0064, 0.0008),
    "instructions": (-0.1715, -0.0561, 0.0650, 0.0157, 0.0010),
}
for name, spec in fields.items():
    pockets(carriers[name], [spec], name + " field pocket")
    bevel(carriers[name], 0.00010)
    install_screen(name + " field", *spec, oled=True)

for name in ("capabilities", "version"):
    bevel(carriers[name], 0.00010)

label("Fallback value", "fallback   none", -0.1740, 0.0477,
      UI, 0.0028, pixel_mid, max_width=0.034)
label("Fallback arrow", "v", -0.1382, 0.0477,
      UI, 0.0022, pixel_mid, align='CENTER')
label("Main loop label", "main loop", -0.2050, 0.0258,
      PANEL + 0.00005, 0.0021, silk_dim_mat)
label("Main agent value", "default", -0.2010, 0.0188,
      UI, 0.0032, pixel_white)
label("Agent arrow", "v", -0.1430, 0.0188,
      UI, 0.0022, pixel_mid, align='CENTER')
keycap("Define agent", -0.1715, 0.0087, 0.0640, 0.0071,
       "+ define agent", size=0.0030)

label("Skills", "skills  28", -0.205, -0.0165,
      PANEL + 0.00005, 0.0030, silk_mat)
label("MCP servers", "mcp servers  0", -0.205, -0.0225,
      PANEL + 0.00005, 0.00265, silk_dim_mat)
rounded_prism(
    "Environment toggle well", -0.2015, -0.0297,
    PANEL + 0.00003, 0.008, 0.0036, 0.0004,
    0.0017, gap_mat, edge=0.00006
)
rounded_prism(
    "Environment toggle slider", -0.2034, -0.0297,
    PANEL + 0.00040, 0.0032, 0.0028, 0.00075,
    0.0011, key_side_mat, edge=0.00009
)
label("Environment legend", "full environment", -0.1948, -0.0297,
      PANEL + 0.00006, 0.0025, silk_dim_mat)
label("Instructions line 1", "appended to the system", -0.2005, -0.0526,
      UI, 0.0030, pixel_mid, max_width=0.058)
label("Instructions line 2", "prompt on every run", -0.2005, -0.0584,
      UI, 0.0030, pixel_mid, max_width=0.058)
keycap("Diff", -0.1960, -0.0907, 0.0200, 0.0090, "diff", size=0.0032)
keycap("Commit", -0.1673, -0.0907, 0.0320, 0.0090, "commit", size=0.0032)

# ---------------------------------------------------------------------------
# Main IPS: clean luminous dark field, crisp high-contrast typography.
# ---------------------------------------------------------------------------

def screen_card(name, x, y, w, h, mat=card_mat):
    rounded_prism(name, x, y, UI - 0.000045,
                  w, h, 0.000035, 0.0012, mat, steps=8)


label("Trajectory heading", "trajectory", -0.116, 0.0812,
      UI, 0.0051, pixel_white)
label("Trajectory session", "98d0e781  /  COMPLETE", 0.123, 0.0812,
      UI, 0.0030, pixel_mid, align='RIGHT')
flat_line("Trajectory header rule", (-0.117, 0.0745), (0.124, 0.0745),
          0.00022, UI, pixel_line)
flat_line("Agent hierarchy trunk", (-0.1160, 0.0640), (-0.1160, -0.0720),
          0.00028, UI, pixel_dim)

screen_card("Subagent grouping", 0.0060, 0.0430, 0.2280, 0.0530)
flat_disc("Subagent complete node", -0.1160, 0.0630, 0.00105, UI, pixel_white)
flat_line("Subagent branch", (-0.1160, 0.0630), (-0.1080, 0.0630),
          0.00024, UI, pixel_dim)
label("Agent call", "Agent   Survey sandbox directory", -0.102, 0.0620,
      UI, 0.00445, pixel_white, max_width=0.215)
label("Agent status", "12 tool calls  /  complete", -0.102, 0.0552,
      UI, 0.00325, pixel_mid)

flat_line("Nested tool trunk", (-0.0995, 0.0474), (-0.0995, 0.0251),
          0.00022, UI, pixel_dim)
for yy in (0.0458, 0.0320):
    flat_line("Nested tool branch", (-0.0995, yy), (-0.0955, yy),
              0.00022, UI, pixel_dim)

label("Bash call", "Bash   find sandbox/ -maxdepth 2 -type f",
      -0.093, 0.0458, UI, 0.0038, pixel_white, max_width=0.205)
label("Bash result", "sandbox/ is a git-ignored scratch/working area.",
      -0.093, 0.0398, UI, 0.00345, pixel_mid, max_width=0.205)
label("Read call", "Read   public/app.js", -0.093, 0.0320,
      UI, 0.0038, pixel_white)
label("Read result", "Headless Claude Code runner; stream-json events.",
      -0.093, 0.0260, UI, 0.00345, pixel_mid, max_width=0.205)

flat_disc("Context complete node", -0.116, 0.0082, 0.00105, UI, pixel_white)
label("Git context heading", "Git context", -0.106, 0.0082,
      UI, 0.0042, pixel_white)
label("Git context 1", "On branch main, up to date with origin/main.",
      -0.106, 0.0016, UI, 0.0036, pixel_mid, max_width=0.227)
label("Git context 2", "Changes are in the real project files, not sandbox/.",
      -0.106, -0.0046, UI, 0.0036, pixel_mid, max_width=0.227)

screen_card("Write grouping", 0.006, -0.0360, 0.228, 0.0480)
flat_disc("Write complete node", -0.116, -0.0187, 0.00105, UI, pixel_white)
flat_line("Write branch", (-0.116, -0.0187), (-0.108, -0.0187),
          0.00024, UI, pixel_dim)
label("Write call", "Write   sandbox/findings.md", -0.102, -0.0187,
      UI, 0.00425, pixel_white)

screen_card("Write JSON well", 0.007, -0.0352, 0.213, 0.0228, code_mat)
for i, text in enumerate((
    '{',
    '  "file_path": "sandbox/findings.md",',
    '  "content": "# Findings\\n\\nSurvey of the sandbox directory..."',
    '}',
)):
    label("Write input %d" % i, text, -0.093, -0.0274 - i * 0.0048,
          UI, 0.00310, pixel_mid, max_width=0.202)

label("Write result", "File created successfully: sandbox/findings.md",
      -0.102, -0.0533, UI, 0.00355, pixel_white, max_width=0.217)

flat_disc("Summary complete node", -0.116, -0.0717, 0.00105, UI, pixel_white)
label("Summary heading", "Summary", -0.106, -0.0717,
      UI, 0.0042, pixel_white)
label("Summary 1", "The sandbox itself is safe to ignore for code review.",
      -0.106, -0.0783, UI, 0.00355, pixel_mid, max_width=0.227)
label("Summary 2", "The actual modified project files live one level up.",
      -0.106, -0.0846, UI, 0.00355, pixel_mid, max_width=0.227)
label("Trajectory totals", "3 turns     14 calls     68.7s", 0.122, -0.0920,
      UI, 0.0028, pixel_dim, align='RIGHT')

# ---------------------------------------------------------------------------
# Scope and outline
# ---------------------------------------------------------------------------

label("Scope heading", "scope", 0.146, 0.0829, UI, 0.0038, pixel_white)
label("Scope status", "done", 0.205, 0.0829,
      UI, 0.0024, pixel_mid, align='RIGHT')
flat_line("Scope header rule", (0.146, 0.0780), (0.205, 0.0780),
          0.00020, UI, pixel_line)

cx, cy = 0.1755, 0.0460
for radius in (0.0140, 0.0210, 0.0280):
    flat_ring("Scope range ring", cx, cy, radius, 0.00017, UI, pixel_line)
flat_line("Scope horizontal axis", (cx - 0.029, cy), (cx + 0.029, cy),
          0.00015, UI, pixel_line)
flat_line("Scope vertical axis", (cx, cy - 0.029), (cx, cy + 0.029),
          0.00015, UI, pixel_line)
flat_line("Scope agent connection", (cx, cy + 0.008), (cx, 0.0684),
          0.00030, UI + 0.000006, pixel_mid)

flat_disc("Main node fill", cx, cy, 0.0081, UI + 0.000008, code_mat)
flat_ring("Main node ring", cx, cy, 0.0081, 0.00055,
          UI + 0.000014, pixel_white)
label("Main count", "2", cx, cy + 0.0014,
      UI + 0.00002, 0.0068, pixel_white, align='CENTER')
label("Main node label", "main", cx, cy - 0.0036,
      UI + 0.00002, 0.0021, pixel_mid, align='CENTER')

flat_disc("Subagent node fill", cx, 0.0718, 0.0047,
          UI + 0.000008, code_mat)
flat_ring("Subagent node ring", cx, 0.0718, 0.0047, 0.00040,
          UI + 0.000014, pixel_mid)
label("Subagent count", "12", cx, 0.0718,
      UI + 0.00002, 0.0038, pixel_white, align='CENTER')
label("Scope legend", "main   /   subagent   /   error", cx, 0.0155,
      UI, 0.00205, pixel_mid, align='CENTER', max_width=0.063)

label("Outline heading", "outline", 0.146, -0.0020, UI, 0.0038, pixel_white)
label("Outline count", "14", 0.205, -0.0020,
      UI, 0.0026, pixel_mid, align='RIGHT')
flat_line("Outline header rule", (0.146, -0.007), (0.205, -0.007),
          0.00020, UI, pixel_line)

outline_rows = [
    (0, "Agent", "Survey sandbox"),
    (1, "Bash", "find sandbox/"),
    (1, "Bash", "git status"),
    (1, "Bash", "git rev-parse"),
    (1, "Read", "index.html"),
    (1, "Read", "public/app.js"),
    (1, "Read", "style.css"),
    (1, "Agent", "Trace runner"),
    (2, "Read", "server.ts"),
    (2, "Read", "package.json"),
    (2, "Grep", "stream-json"),
    (1, "Bash", "git diff --stat"),
    (0, "Write", "findings.md"),
    (0, "done", "complete"),
]
flat_line("Outline nesting rail", (0.1500, -0.0178), (0.1500, -0.0780),
          0.00017, UI, pixel_line)
flat_line("Outline subagent rail", (0.1540, -0.0555), (0.1540, -0.0720),
          0.00017, UI, pixel_line)
for i, (indent, tool, argument) in enumerate(outline_rows):
    y = -0.0140 - i * 0.00565
    x = 0.1460 + indent * 0.0036
    flat_disc("Outline completion %d" % i, x, y, 0.00035,
              UI, pixel_mid, segments=12)
    label("Outline tool %d" % i, tool, x + 0.0020, y,
          UI, 0.00265, pixel_white)
    label("Outline argument %d" % i, argument, x + 0.0120, y,
          UI, 0.00245, pixel_mid, max_width=0.2055 - x - 0.012)

# ---------------------------------------------------------------------------
# Bottom input row
# ---------------------------------------------------------------------------

prompt_spec = (0.0165, -0.1179, 0.3160, 0.0152, 0.0014)
pockets(carriers["prompt"], [prompt_spec], "Prompt glass pocket")
bevel(carriers["prompt"], 0.00010)
install_screen("Prompt", *prompt_spec, oled=True)

keycap("Attach", -0.2000, -0.1179, 0.0125, 0.0114, "+", size=0.0039)
keycap("File", -0.1820, -0.1179, 0.0180, 0.0114, "file", size=0.0031)
keycap("Microphone", -0.1606, -0.1179, 0.0150, 0.0114, "mic", size=0.0029)
keycap("Run", 0.1947, -0.1179, 0.0270, 0.0150, "run",
       orange=True, size=0.0045)

label("Prompt chevron", ">", -0.1356, -0.1179, UI, 0.0041, pixel_white)
label("Prompt placeholder", "command the agent...", -0.1280, -0.1179,
      UI, 0.0038, pixel_mid)
label("Replay source", "replayed 2026-09-20T06-05-34-899Z.jsonl",
      -0.204, -0.1280, PANEL + 0.00005, 0.0020, silk_dim_mat)

# ---------------------------------------------------------------------------
# Dark studio: retain the successful rim, lift the rack, control reflections.
# ---------------------------------------------------------------------------

bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.00015))
floor = bpy.context.object
floor.name = "Dark seamless studio ground"
floor.data.materials.append(floor_mat)

world = bpy.data.worlds.new("Dark neutral studio")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.05, 0.05, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.028


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def area_light(name, location, target, energy, width, height,
               color=(1.0, 1.0, 1.0)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.color = color
    data.shape = 'RECTANGLE'
    data.size = width
    data.size_y = height
    if hasattr(data, "normalize"):
        data.normalize = True
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = location
    aim(obj, target)
    return obj


area_light(
    "KEY / raised soft strip for readable rack",
    (-0.33, -0.16, 0.43), (-0.085, 0.0, 0.015),
    4.1, 0.46, 0.17
)
area_light(
    "TOP FILL / restrained broad deck illumination",
    (-0.27, 0.30, 0.52), (-0.115, 0.00, 0.021),
    0.65, 0.40, 0.28
)
area_light(
    "FILL / dim neutral-cool frontal card",
    (0.39, -0.32, 0.43), (0.02, 0.00, 0.012),
    0.50, 0.35, 0.27, color=(0.95, 0.975, 1.0)
)
area_light(
    "RIM / narrow rear separation",
    (0.06, 0.38, 0.235), (0.01, 0.01, 0.018),
    4.2, 0.29, 0.015
)

# A faint, finite rectangular source reflected at the upper-right glass edge.
# No scratches, caustic tricks, bright streak filters or large white overlays.
reflection_card = area_light(
    "GLASS / faint angled soft reflection",
    (0.020, 0.675, 0.650), (0.105, 0.055, 0.021),
    0.060, 0.18, 0.055
)
reflection_card.rotation_euler.rotate_axis('Z', math.radians(23))
if hasattr(reflection_card.data, "diffuse_factor"):
    reflection_card.data.diffuse_factor = 0.0

# The screen itself is emissive. These upward-facing, low-power sampling
# proxies approximate its integrated backlight for clean bezel/keycap spill.
spill = area_light(
    "IPS / integrated upward backlight spill",
    (0.0035, -0.0040, GLASS_TOP + 0.00025),
    (0.0035, -0.0040, GLASS_TOP + 1.0),
    0.055, 0.248, 0.180
)
if hasattr(spill.data, "specular_factor"):
    spill.data.specular_factor = 0.45

oled_spill = area_light(
    "OLED / integrated upward numeric spill",
    (0.021, 0.113, GLASS_TOP + 0.00022),
    (0.021, 0.113, GLASS_TOP + 1.0),
    0.0045, 0.172, 0.016
)
if hasattr(oled_spill.data, "specular_factor"):
    oled_spill.data.specular_factor = 0.35

# ---------------------------------------------------------------------------
# 85 mm hero lens. Slightly tighter framing; everything intentionally in focus.
# ---------------------------------------------------------------------------

camera_data = bpy.data.cameras.new("85 mm product-study lens")
camera = bpy.data.objects.new("Hero camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
camera.location = (0.25, -0.91, 1.01)
aim(camera, (0.0, 0.0, 0.016))
camera_data.type = 'PERSP'
camera_data.lens = 85
camera_data.sensor_width = 36
camera_data.clip_start = 0.01
camera_data.clip_end = 100
camera_data.dof.use_dof = False

# Fit text against real built-in-font bounds, not pessimistic character counts.
# This preserves large numeral anchors and improves the small control legends.
bpy.context.view_layer.update()
fit_changes = []
for obj, maximum_width in text_fits:
    width = obj.dimensions.x
    if width > maximum_width and width > 0:
        fit_changes.append((obj, maximum_width / width))
for obj, scale in fit_changes:
    obj.scale.x = scale
    obj.scale.y = scale

bpy.context.view_layer.update()

# Explicitly bypass compositing: the prior glare failure cannot recur.
scene.render.use_compositing = False
scene.render.use_sequencer = False
bpy.context.scene.render.filepath = OUTPUT
bpy.ops.render.render(write_still=True)

"""Recompute the skin weights of a Mesh2Motion GLB with Blender's automatic weights (bone heat).

Run by the reweight_with_blender tool:

    blender -b --factory-startup --python-exit-code 1 --python blender_reweight.py -- \
        IN.glb OUT.glb [--smooth 2] [--max-influences 4]

Only the vertex weights change: the skeleton, its rest pose and the animations are written
back as Mesh2Motion exported them. Prints one line "M2M_RESULT {json}" with a summary.
"""
import json
import struct
import sys

import bpy
from mathutils import Vector

RESULT_PREFIX = "M2M_RESULT "


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        raise SystemExit("usage: blender -b --python blender_reweight.py -- IN.glb OUT.glb [--smooth N] [--max-influences N]")

    def option(name, default):
        return int(argv[argv.index(name) + 1]) if name in argv else default

    return argv[0], argv[1], option("--smooth", 2), option("--max-influences", 4)


def object_mode():
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")


def select_only(objects, active):
    object_mode()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = active


def read_weights(mesh):
    """Per vertex index: [(group name, weight)] for the non-zero weights."""
    names = {group.index: group.name for group in mesh.vertex_groups}
    return {
        vertex.index: [(names[g.group], g.weight) for g in vertex.groups if g.weight > 1e-4 and g.group in names]
        for vertex in mesh.data.vertices
    }


def build_heat_rig(arm, deform_names, model_height):
    """Temporary armature with the same bone names whose segments run joint -> child joint.

    Bone heat weights each vertex by its distance to the bone segments. The imported bones
    point along their joint's local axis, which rarely follows the limb, so the segments are
    rebuilt here: each bone ends at the child that best continues the direction it came from
    (spine over thighs at the pelvis, the middle finger at the hand), or in a short stub at a tip.
    """
    rig_data = bpy.data.armatures.new("M2M_HeatRig")
    rig = bpy.data.objects.new("M2M_HeatRig", rig_data)
    bpy.context.scene.collection.objects.link(rig)
    rig.matrix_world = arm.matrix_world.copy()
    select_only([rig], rig)
    bpy.ops.object.mode_set(mode="EDIT")

    for bone in arm.data.bones:
        rig_data.edit_bones.new(bone.name).head = bone.head_local
    min_stub = max(model_height * 0.01, 1e-3)
    for bone in arm.data.bones:
        edit_bone = rig_data.edit_bones[bone.name]
        if bone.parent is not None:
            edit_bone.parent = rig_data.edit_bones[bone.parent.name]
        incoming = bone.head_local - bone.parent.head_local if bone.parent is not None else Vector((0, 0, 1))
        direction = incoming.normalized() if incoming.length > 1e-6 else Vector((0, 0, 1))
        children = [child for child in bone.children if (child.head_local - bone.head_local).length > min_stub * 0.1]
        if children:
            child = max(children, key=lambda c: (c.head_local - bone.head_local).normalized().dot(direction))
            edit_bone.tail = child.head_local
        else:
            edit_bone.tail = bone.head_local + direction * max(incoming.length * 0.25, min_stub)
    bpy.ops.object.mode_set(mode="OBJECT")

    for bone in rig_data.bones:
        bone.use_deform = bone.name in deform_names
    return rig


def glb_summary(path):
    with open(path, "rb") as file:
        data = file.read()
    length = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + length])
    return {
        "animations": [animation.get("name", "") for animation in gltf.get("animations", [])],
        "joints": [len(skin["joints"]) for skin in gltf.get("skins", [])],
    }


def main():
    src, dst, smooth, max_influences = parse_args()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    # UV seams split the exported vertices; merged, the mesh is one surface for the heat solve
    # (Blender keeps UVs per face corner, and the exporter splits the seams again).
    bpy.ops.import_scene.gltf(filepath=src, merge_vertices=True)
    scene = bpy.context.scene

    armatures = [obj for obj in scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise SystemExit(f"Expected one skeleton in {src}, found {len(armatures)}")
    arm = armatures[0]
    meshes = [obj for obj in scene.objects
              if obj.type == "MESH" and any(m.type == "ARMATURE" and m.object == arm for m in obj.modifiers)]
    if not meshes:
        raise SystemExit(f"No skinned mesh in {src}: export with contents \"full\"")

    original = {mesh.name: read_weights(mesh) for mesh in meshes}
    # Deforming bones: every bone between a parent and children, plus any bone Mesh2Motion gave
    # weights to. That leaves out the tip markers (no children, e.g. *_leaf, or the finger stub of
    # a single-bone hand) and an unweighted root. Mesh2Motion's own list is not enough on its own:
    # on coarse meshes some bones (pelvis, finger bases) end up with no vertex at all.
    weighted = {name for weights in original.values() for entries in weights.values() for name, _ in entries}
    deform_names = weighted | {bone.name for bone in arm.data.bones if bone.parent is not None and bone.children}
    height = max((obj.dimensions.z for obj in meshes), default=1.0)
    rig = build_heat_rig(arm, deform_names, height)

    mesh_reports = []
    for mesh in meshes:
        world = mesh.matrix_world.copy()
        mesh.parent = None
        mesh.matrix_world = world
        for modifier in list(mesh.modifiers):
            if modifier.type == "ARMATURE":
                mesh.modifiers.remove(modifier)
        mesh.vertex_groups.clear()

        select_only([mesh, rig], rig)
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")

        # Vertices the heat solve could not reach (detached pieces such as eyes or buttons)
        # keep the weights Mesh2Motion gave them.
        restored = 0
        for vertex in mesh.data.vertices:
            if any(g.weight > 1e-4 for g in vertex.groups):
                continue
            for name, weight in original[mesh.name].get(vertex.index, []):
                group = mesh.vertex_groups.get(name) or mesh.vertex_groups.new(name=name)
                group.add([vertex.index], weight, "REPLACE")
            restored += 1

        select_only([mesh], mesh)
        bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
        if smooth > 0:
            bpy.ops.object.vertex_group_smooth(group_select_mode="ALL", factor=0.5, repeat=smooth)
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=max_influences)
        bpy.ops.object.vertex_group_normalize_all(lock_active=False)
        bpy.ops.object.mode_set(mode="OBJECT")

        # Back onto the original skeleton: the vertex groups match its bone names.
        world = mesh.matrix_world.copy()
        mesh.parent = None
        for modifier in mesh.modifiers:
            if modifier.type == "ARMATURE":
                modifier.object = arm
        mesh.parent = arm
        mesh.matrix_world = world
        mesh_reports.append({"name": mesh.name, "vertices": len(mesh.data.vertices), "restored_vertices": restored})

    rig_data = rig.data
    bpy.data.objects.remove(rig)
    bpy.data.armatures.remove(rig_data)

    export_options = {"filepath": dst, "export_format": "GLB", "export_animations": True,
                      "export_skins": True, "export_influence_nb": max_influences}
    if "export_animation_mode" in bpy.ops.export_scene.gltf.get_rna_type().properties:
        export_options["export_animation_mode"] = "ACTIONS"
    bpy.ops.export_scene.gltf(**export_options)

    print(RESULT_PREFIX + json.dumps({
        "blender": bpy.app.version_string,
        "bones": len(arm.data.bones),
        "deform_bones": len(deform_names),
        "meshes": mesh_reports,
        "smooth": smooth,
        "max_influences": max_influences,
        **glb_summary(dst),
    }))


main()

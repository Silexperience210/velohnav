#!/usr/bin/env python3
# Réécrit les MatMulNBits (poids 4 bits) d'un modèle ONNX en DynamicQuantizeLinear +
# MatMulInteger (poids int8 symétriques, une échelle par colonne).
#
# Pourquoi : dans onnxruntime-web (WASM), MatMulNBits n'a pas de noyau dédié — il
# redéquantifie la matrice ENTIÈRE à chaque appel, donc à chaque jeton : 14,5 ms pour
# un produit 1024×4608, contre 1,0 ms pour MatMulInteger, qui a un noyau SIMD WASM.
# Sert au banc (vitesse et qualité de la variante int8) ; rien ne l'embarque dans l'APK.
#
#   python -I scripts/bench-chat/q4-to-int8.py <model_q4.onnx> <sortie.onnx> [motif-gardé-en-q4]
#
# Mesuré : convertir TOUT rend le modèle inutilisable (accord top-1 nul avec q4) —
# DynamicQuantizeLinear quantifie l'activation sur un seul uint8 par tenseur, et les
# entrées de mlp/down_proj et conv/out_proj ont un rapport max/médiane de 1000 à 2500
# (erreur de quantification jusqu'à 73 %). Le motif (expression régulière sur le nom
# du nœud) garde ces couches en MatMulNBits.
import sys, os, re
import numpy as np
import onnx
from onnx import helper as h, numpy_helper as nh, TensorProto as T

src, dst = sys.argv[1], sys.argv[2]
keep_q4 = re.compile(sys.argv[3]) if len(sys.argv) > 3 else None
m = onnx.load(src)  # données externes comprises
inits = {i.name: i for i in m.graph.initializer}
arr = lambda name: nh.to_array(inits[name])

def dequant(node):
    a = {x.name: h.get_attribute_value(x) for x in node.attribute}
    K, N, bits, bs = a["K"], a["N"], a["bits"], a["block_size"]
    assert bits == 4, node.name
    nb = (K + bs - 1) // bs
    B = arr(node.input[1]).reshape(N, nb, bs // 2)
    q = np.empty((N, nb, bs), np.float32)
    q[..., 0::2] = B & 0x0F
    q[..., 1::2] = B >> 4
    s = arr(node.input[2]).astype(np.float32).reshape(N, nb, 1)
    if len(node.input) > 3 and node.input[3]:
        zp = arr(node.input[3])
        if zp.dtype == np.uint8:
            zp = zp.reshape(N, -1)
            z = np.empty((N, zp.shape[1] * 2), np.float32)
            z[:, 0::2] = zp & 0x0F
            z[:, 1::2] = zp >> 4
            z = z[:, :nb].reshape(N, nb, 1)
        else:
            z = zp.astype(np.float32).reshape(N, nb, 1)
    else:
        z = 8.0
    assert len(node.input) <= 4 or not any(node.input[4:]), f"g_idx/biais non gérés : {node.name}"
    return ((q - z) * s).reshape(N, nb * bs)[:, :K].T  # (K, N)

nodes, new_inits, dropped = [], [], set()
for n in m.graph.node:
    if n.op_type != "MatMulNBits" or (keep_q4 and keep_q4.search(n.name)):
        nodes.append(n)
        continue
    W = dequant(n)
    scale = np.maximum(np.abs(W).max(axis=0), 1e-12) / 127.0
    Wq = np.clip(np.rint(W / scale), -127, 127).astype(np.int8)
    p, A, Y = n.name or n.output[0], n.input[0], n.output[0]
    new_inits += [nh.from_array(Wq, p + "_w8"), nh.from_array(scale.astype(np.float32), p + "_ws")]
    nodes += [
        h.make_node("DynamicQuantizeLinear", [A], [p + "_aq", p + "_as", p + "_az"]),
        h.make_node("MatMulInteger", [p + "_aq", p + "_w8", p + "_az"], [p + "_yi"]),
        h.make_node("Cast", [p + "_yi"], [p + "_yf"], to=T.FLOAT),
        h.make_node("Mul", [p + "_yf", p + "_as"], [p + "_y1"]),
        h.make_node("Mul", [p + "_y1", p + "_ws"], [Y]),
    ]
    dropped.update(x for x in n.input[1:] if x)

# Les poids liés (lm_head = embed_tokens) restent utilisés par GatherBlockQuantized.
dropped -= {x for n in nodes for x in n.input}
keep = [i for i in m.graph.initializer if i.name not in dropped]
del m.graph.node[:]
m.graph.node.extend(nodes)
del m.graph.initializer[:]
m.graph.initializer.extend(keep + new_inits)
data = os.path.basename(dst) + "_data"
if os.path.exists(os.path.join(os.path.dirname(dst), data)):
    os.remove(os.path.join(os.path.dirname(dst), data))
onnx.save(m, dst, save_as_external_data=True, all_tensors_to_one_file=True, location=data, size_threshold=1024)
print(f"{dst} : {len(new_inits) // 2} MatMulNBits réécrits, données {os.path.getsize(os.path.join(os.path.dirname(dst), data)) / 1e6:.0f} Mo")

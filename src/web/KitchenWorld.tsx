import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Vector3 } from "three";
import type { Group, Mesh } from "three";
import type { RunSnapshot, StationId } from "../shared/contracts";

// WebGL materials cannot resolve CSS custom properties. These values mirror the
// semantic tokens in styles.css so the canvas and accessible HTML stay aligned.
const WORLD_COLOR = {
  background: "#e8dfd3",
  floor: "#d8c6ae",
  floorLine: "#c0a98d",
  counter: "#b8794e",
  counterTop: "#e9c89f",
  edge: "#4e352b",
  stationUp: "#3f715d",
  stationDown: "#a94331",
  stationPanel: "#253f3a",
  steel: "#b8b4aa",
  steelDark: "#6b6963",
  plate: "#fffaf0",
  meal: "#d99a2b",
  garnish: "#56784d",
  person: "#a84227",
  skin: "#c98d68",
  cloth: "#6c8276",
  brass: "#c6903e",
  steam: "#fffaf0"
} as const;

export const PREVIEW_SNAPSHOT: RunSnapshot = {
  runId: "preview",
  mode: "MOCK",
  clockMs: 0,
  version: 1,
  stations: {
    tawa: { status: "UP", activeOrderId: "preview-order" },
    bowls: { status: "UP", activeOrderId: null }
  },
  stock: { batter: 6, oil: 6, potato_mix: 3, rice: 6, lemon_mix: 3, peanuts: 3, curd: 3 },
  actors: [
    { id: "human", name: "You", kind: "HUMAN", status: "READY" },
    { id: "asha", name: "Asha", kind: "SCRIPTED", status: "READY" },
    { id: "kabir", name: "Kabir", kind: "SCRIPTED", status: "READY" }
  ],
  salesStopped: false,
  razorpayEnabled: false,
  intent: null,
  currentOrder: {
    id: "preview-order",
    dishId: "plain_dosa",
    dishName: "Plain dosa",
    amountPaise: 12000,
    currency: "INR",
    stationId: "tawa",
    localState: "COOKING",
    createState: "CREATED",
    paymentStatus: "captured",
    refundState: null,
    checkoutIssued: false,
    providerOrderIdSuffix: null,
    providerPaymentIdSuffix: null,
    providerRefundIdSuffix: null
  },
  events: []
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function webGlAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function Station({ id, status }: { id: StationId; status: "UP" | "DOWN" }) {
  const x = id === "tawa" ? -2.25 : 2.25;
  const active = status === "UP";
  const statusColor = active ? WORLD_COLOR.stationUp : WORLD_COLOR.stationDown;
  return <group position={[x, 0, 0]}>
    <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
      <boxGeometry args={[2.1, 0.84, 1.68]} />
      <meshStandardMaterial color={statusColor} roughness={0.72} metalness={0.08} />
    </mesh>
    <mesh position={[0, 0.88, 0]} castShadow receiveShadow>
      <boxGeometry args={[2.22, 0.14, 1.8]} />
      <meshStandardMaterial color={WORLD_COLOR.counterTop} roughness={0.52} />
    </mesh>
    <mesh position={[0, 0.42, 0.86]} castShadow>
      <boxGeometry args={[1.72, 0.44, 0.04]} />
      <meshStandardMaterial color={WORLD_COLOR.stationPanel} roughness={0.38} metalness={0.2} />
    </mesh>
    <mesh position={[0, 0.55, 0.89]}>
      <boxGeometry args={[0.82, 0.035, 0.025]} />
      <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={active ? 0.8 : 0.15} />
    </mesh>
    <mesh position={[-0.68, 0.2, 0.9]}>
      <cylinderGeometry args={[0.045, 0.045, 0.045, 12]} />
      <meshStandardMaterial color={WORLD_COLOR.brass} metalness={0.7} roughness={0.28} />
    </mesh>
    {id === "tawa" ? <>
      <mesh position={[0, 1.03, 0]} castShadow>
        <cylinderGeometry args={[0.7, 0.74, 0.12, 24]} />
        <meshStandardMaterial color={WORLD_COLOR.steelDark} metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[0, 1.1, 0]}>
        <cylinderGeometry args={[0.58, 0.58, 0.035, 24]} />
        <meshStandardMaterial color={WORLD_COLOR.steel} metalness={0.45} roughness={0.28} />
      </mesh>
      <mesh position={[0.75, 1.03, -0.02]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.09, 0.09, 0.72, 12]} />
        <meshStandardMaterial color={WORLD_COLOR.steelDark} metalness={0.5} roughness={0.35} />
      </mesh>
    </> : <>
      <mesh position={[0, 1.02, 0]} castShadow>
        <cylinderGeometry args={[0.57, 0.68, 0.12, 20]} />
        <meshStandardMaterial color={WORLD_COLOR.steel} metalness={0.45} roughness={0.3} />
      </mesh>
      <mesh position={[0, 1.1, 0]}>
        <torusGeometry args={[0.42, 0.055, 8, 20]} />
        <meshStandardMaterial color={WORLD_COLOR.brass} metalness={0.65} roughness={0.27} />
      </mesh>
    </>}
    <pointLight position={[0, 0.65, 0.98]} color={statusColor} intensity={active ? 0.22 : 0.08} distance={2.3} />
  </group>;
}

function VoxelPerson({ x, z, index, working, reducedMotion }: { x: number; z: number; index: number; working: boolean; reducedMotion: boolean }) {
  const root = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const leftLeg = useRef<Group>(null);
  const rightLeg = useRef<Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  useFrame(({ clock }) => {
    if (!root.current || reducedMotion) return;
    const phase = clock.elapsedTime * (working ? 2.9 : 1.7) + index * 0.9;
    root.current.position.y = Math.sin(phase) * 0.035;
    root.current.rotation.y = Math.sin(phase * 0.35) * 0.08;
    if (leftArm.current) leftArm.current.rotation.z = Math.sin(phase) * (working ? 0.36 : 0.12);
    if (rightArm.current) rightArm.current.rotation.z = -Math.sin(phase + 0.65) * (working ? 0.36 : 0.12);
    if (leftLeg.current) leftLeg.current.rotation.x = Math.sin(phase) * 0.12;
    if (rightLeg.current) rightLeg.current.rotation.x = -Math.sin(phase) * 0.12;
    invalidate();
  });
  const apronColor = index === 1 ? WORLD_COLOR.cloth : index === 2 ? WORLD_COLOR.stationPanel : WORLD_COLOR.person;
  return <group ref={root} position={[x, 0, z]}>
    <group ref={leftLeg} position={[-0.14, 0.28, 0]}>
      <mesh position={[0, 0, 0]} castShadow><boxGeometry args={[0.22, 0.52, 0.22]} /><meshStandardMaterial color={WORLD_COLOR.stationPanel} roughness={0.82} /></mesh>
      <mesh position={[0, -0.27, 0.06]} castShadow><boxGeometry args={[0.28, 0.1, 0.34]} /><meshStandardMaterial color={WORLD_COLOR.edge} roughness={0.72} /></mesh>
    </group>
    <group ref={rightLeg} position={[0.14, 0.28, 0]}>
      <mesh position={[0, 0, 0]} castShadow><boxGeometry args={[0.22, 0.52, 0.22]} /><meshStandardMaterial color={WORLD_COLOR.stationPanel} roughness={0.82} /></mesh>
      <mesh position={[0, -0.27, 0.06]} castShadow><boxGeometry args={[0.28, 0.1, 0.34]} /><meshStandardMaterial color={WORLD_COLOR.edge} roughness={0.72} /></mesh>
    </group>
    <mesh position={[0, 0.77, 0]} castShadow><boxGeometry args={[0.68, 0.68, 0.38]} /><meshStandardMaterial color={apronColor} roughness={0.76} /></mesh>
    <mesh position={[0, 0.78, 0.205]} castShadow><boxGeometry args={[0.34, 0.5, 0.035]} /><meshStandardMaterial color={WORLD_COLOR.counterTop} roughness={0.82} /></mesh>
    <group ref={leftArm} position={[-0.43, 0.9, 0]}>
      <mesh position={[0, -0.24, 0]} castShadow><boxGeometry args={[0.2, 0.56, 0.2]} /><meshStandardMaterial color={WORLD_COLOR.person} roughness={0.82} /></mesh>
      <mesh position={[0, -0.56, 0]} castShadow><boxGeometry args={[0.2, 0.18, 0.2]} /><meshStandardMaterial color={WORLD_COLOR.skin} roughness={0.9} /></mesh>
    </group>
    <group ref={rightArm} position={[0.43, 0.9, 0]}>
      <mesh position={[0, -0.24, 0]} castShadow><boxGeometry args={[0.2, 0.56, 0.2]} /><meshStandardMaterial color={WORLD_COLOR.person} roughness={0.82} /></mesh>
      <mesh position={[0, -0.56, 0]} castShadow><boxGeometry args={[0.2, 0.18, 0.2]} /><meshStandardMaterial color={WORLD_COLOR.skin} roughness={0.9} /></mesh>
    </group>
    <mesh position={[0, 1.37, 0]} castShadow><boxGeometry args={[0.52, 0.52, 0.52]} /><meshStandardMaterial color={WORLD_COLOR.skin} roughness={0.88} /></mesh>
    <mesh position={[0, 1.62, 0]} castShadow><boxGeometry args={[0.6, 0.16, 0.58]} /><meshStandardMaterial color={WORLD_COLOR.plate} roughness={0.82} /></mesh>
    <mesh position={[0, 1.73, 0]} castShadow><boxGeometry args={[0.4, 0.16, 0.42]} /><meshStandardMaterial color={WORLD_COLOR.steam} roughness={0.85} /></mesh>
    <mesh position={[-0.12, 1.4, 0.27]}><boxGeometry args={[0.07, 0.08, 0.035]} /><meshStandardMaterial color={WORLD_COLOR.edge} roughness={0.9} /></mesh>
    <mesh position={[0.12, 1.4, 0.27]}><boxGeometry args={[0.07, 0.08, 0.035]} /><meshStandardMaterial color={WORLD_COLOR.edge} roughness={0.9} /></mesh>
  </group>;
}

function OrderSignal({ order, reducedMotion }: { order: NonNullable<RunSnapshot["currentOrder"]>; reducedMotion: boolean }) {
  const signal = useRef<Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  const [x, y, z] = orderPosition(order);
  const color = order.localState === "CANCELLED" ? WORLD_COLOR.stationDown : order.localState === "READY" || order.localState === "SERVED" ? WORLD_COLOR.stationUp : WORLD_COLOR.brass;
  useFrame(({ clock }) => {
    if (!signal.current || reducedMotion) return;
    signal.current.rotation.y = clock.elapsedTime * 0.7;
    signal.current.position.y = y + 0.46 + Math.sin(clock.elapsedTime * 2.2) * 0.05;
    invalidate();
  });
  return <group ref={signal} position={[x, y + 0.46, z]}>
    <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.34, 0.035, 8, 20]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} metalness={0.35} roughness={0.4} /></mesh>
    {[0, 1, 2].map((index) => <mesh key={index} position={[(index - 1) * 0.2, 0.15 + (index % 2) * 0.08, 0]}><boxGeometry args={[0.09, 0.09, 0.09]} /><meshStandardMaterial color={index === 1 ? color : WORLD_COLOR.plate} emissive={index === 1 ? color : undefined} emissiveIntensity={0.5} /></mesh>)}
  </group>;
}

function orderPosition(order: NonNullable<RunSnapshot["currentOrder"]>): [number, number, number] {
  const stationX = order.stationId === "tawa" ? -2.25 : 2.25;
  switch (order.localState) {
    case "AWAITING_PAYMENT": return [0, 0.34, 2.2];
    case "QUEUED": return [stationX, 1.3, 1.15];
    case "COOKING": return [stationX, 1.3, 0];
    case "READY": return [0, 1.05, -0.4];
    case "SERVED": return [0, 1.05, -1.2];
    case "CANCELLED": return [0, 0.25, 2.8];
  }
}

function Steam({ reducedMotion }: { reducedMotion: boolean }) {
  const steam = useRef<Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  useFrame(({ clock }) => {
    if (!steam.current || reducedMotion) return;
    const time = clock.elapsedTime;
    steam.current.children.forEach((child, index) => {
      child.position.y = 1.3 + ((time * 0.32 + index * 0.24) % 0.9);
      child.position.x = Math.sin(time * 1.7 + index) * 0.09 + (index - 1) * 0.12;
      child.scale.setScalar(0.7 + ((time * 0.4 + index) % 0.6));
      const material = (child as Mesh).material;
      if ("opacity" in material) material.opacity = 0.3 - (((time * 0.3 + index * 0.25) % 0.7) * 0.28);
    });
    invalidate();
  });
  return <group ref={steam} position={[-2.25, 0, 0]}>
    {[0, 1, 2].map((index) => <mesh key={index} position={[(index - 1) * 0.12, 1.3 + index * 0.24, 0]}>
      <sphereGeometry args={[0.1, 10, 8]} />
      <meshStandardMaterial color={WORLD_COLOR.steam} transparent opacity={0.2} roughness={1} />
    </mesh>)}
  </group>;
}

function Meal({ order, reducedMotion }: { order: NonNullable<RunSnapshot["currentOrder"]>; reducedMotion: boolean }) {
  const meal = useRef<Group>(null);
  const visual = useRef<Group>(null);
  const mounted = useRef(false);
  const invalidate = useThree((state) => state.invalidate);
  const target = useMemo(() => new Vector3(...orderPosition(order)), [order.localState, order.stationId]);
  const isCooking = order.localState === "COOKING";
  useLayoutEffect(() => {
    if (!meal.current) return;
    if (!mounted.current) {
      meal.current.position.copy(target);
      mounted.current = true;
    }
    invalidate();
  }, [invalidate, target]);
  useFrame(({ clock }, delta) => {
    if (!meal.current || !visual.current) return;
    if (reducedMotion) {
      meal.current.position.copy(target);
      visual.current.position.y = 0;
      visual.current.rotation.y = 0;
      return;
    }
    meal.current.position.lerp(target, Math.min(1, delta * 4.5));
    visual.current.position.y = isCooking ? Math.sin(clock.elapsedTime * 3.2) * 0.045 : 0;
    visual.current.rotation.y += delta * (isCooking ? 0.45 : 0.12);
    if (meal.current.position.distanceToSquared(target) > 0.0001 || isCooking) invalidate();
  });
  return <group ref={meal}>
    <group ref={visual}>
      <mesh position={[0, 0, 0]} castShadow>
        <cylinderGeometry args={[0.46, 0.5, 0.13, 24]} />
        <meshStandardMaterial color={WORLD_COLOR.plate} roughness={0.42} />
      </mesh>
      <mesh position={[0, 0.09, 0]} castShadow>
        <cylinderGeometry args={[0.34, 0.38, 0.1, 20]} />
        <meshStandardMaterial color={isCooking ? WORLD_COLOR.meal : WORLD_COLOR.counterTop} roughness={0.78} />
      </mesh>
      <mesh position={[-0.12, 0.17, 0.06]}>
        <sphereGeometry args={[0.06, 10, 8]} />
        <meshStandardMaterial color={WORLD_COLOR.garnish} roughness={0.85} />
      </mesh>
      <mesh position={[0.1, 0.17, -0.05]}>
        <sphereGeometry args={[0.045, 10, 8]} />
        <meshStandardMaterial color={WORLD_COLOR.garnish} roughness={0.85} />
      </mesh>
    </group>
  </group>;
}

function KitchenCounter() {
  return <group position={[0, 0, -1.25]}>
    <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
      <boxGeometry args={[2.3, 0.84, 1.1]} />
      <meshStandardMaterial color={WORLD_COLOR.counter} roughness={0.72} />
    </mesh>
    <mesh position={[0, 0.9, 0]} castShadow receiveShadow>
      <boxGeometry args={[2.42, 0.14, 1.2]} />
      <meshStandardMaterial color={WORLD_COLOR.counterTop} roughness={0.45} />
    </mesh>
    <mesh position={[0, 0.98, 0]}>
      <boxGeometry args={[2.12, 0.035, 0.88]} />
      <meshStandardMaterial color={WORLD_COLOR.edge} roughness={0.58} />
    </mesh>
    {[-0.72, 0.72].map((x) => <mesh key={x} position={[x, 0.18, 0.4]}>
      <boxGeometry args={[0.12, 0.36, 0.08]} />
      <meshStandardMaterial color={WORLD_COLOR.brass} metalness={0.65} roughness={0.3} />
    </mesh>)}
  </group>;
}

function World({ snapshot, reducedMotion }: { snapshot: RunSnapshot; reducedMotion: boolean }) {
  const stage = useRef<Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  const cookingOnTawa = snapshot.currentOrder?.localState === "COOKING" && snapshot.currentOrder.stationId === "tawa";
  const working = snapshot.currentOrder?.localState === "QUEUED" || snapshot.currentOrder?.localState === "COOKING";
  useFrame(({ clock }) => {
    if (!stage.current || reducedMotion) return;
    stage.current.rotation.y = Math.sin(clock.elapsedTime * 0.22) * 0.018;
    stage.current.position.y = Math.sin(clock.elapsedTime * 0.65) * 0.012;
    invalidate();
  });
  return <>
    <color attach="background" args={[WORLD_COLOR.background]} />
    <ambientLight intensity={1.15} />
    <hemisphereLight args={["#fff8ec", "#80614b", 0.9]} />
    <directionalLight position={[4, 7, 5]} intensity={2.5} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-far={30} />
    <group ref={stage}>
      <mesh position={[0, -0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[10, 8]} />
        <meshStandardMaterial color={WORLD_COLOR.floor} roughness={1} />
      </mesh>
      {[-3.1, -1.55, 0, 1.55, 3.1].map((z) => <mesh key={z} position={[0, 0.01, z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[9.2, 0.018]} />
        <meshBasicMaterial color={WORLD_COLOR.floorLine} transparent opacity={0.42} />
      </mesh>)}
      <mesh position={[0, 2.7, -3.4]} receiveShadow>
        <boxGeometry args={[10, 5.3, 0.12]} />
        <meshStandardMaterial color={WORLD_COLOR.background} roughness={1} />
      </mesh>
      <Station id="tawa" status={snapshot.stations.tawa.status} />
      <Station id="bowls" status={snapshot.stations.bowls.status} />
      <KitchenCounter />
      {cookingOnTawa && <Steam reducedMotion={reducedMotion} />}
      {snapshot.actors.filter((actor) => actor.status === "READY").map((actor, index) => <VoxelPerson key={actor.id} x={-0.78 + index * 0.78} z={2.8} index={index} working={working} reducedMotion={reducedMotion} />)}
      {snapshot.currentOrder && <>
        <Meal order={snapshot.currentOrder} reducedMotion={reducedMotion} />
        <OrderSignal order={snapshot.currentOrder} reducedMotion={reducedMotion} />
      </>}
    </group>
  </>;
}

export function KitchenWorld({ snapshot, preview = false }: { snapshot: RunSnapshot; preview?: boolean }) {
  const reducedMotion = useReducedMotion();
  const [canRenderWebGl] = useState(webGlAvailable);
  const orderState = snapshot.currentOrder?.localState.replaceAll("_", " ").toLowerCase() ?? "no active meal";
  const label = `${preview ? "Preview" : "Live"} 3D kitchen. Tawa ${snapshot.stations.tawa.status.toLowerCase()}, bowl station ${snapshot.stations.bowls.status.toLowerCase()}, ${orderState}.`;
  if (!canRenderWebGl) return <div className="kitchen-world world-fallback" role="img" aria-label={label}>
    <p><strong>3D preview unavailable.</strong><br />{preview ? "The interactive controls will still show the product flow." : "Station controls and confirmed status remain available below."}</p>
  </div>;
  return <div className={`kitchen-world${preview ? " preview-world" : ""}`} role="img" aria-label={label}>
    <Canvas
      aria-hidden="true"
      shadows
      frameloop="demand"
      dpr={[1, 1.5]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      orthographic
      camera={{ position: [6, 6, 7], zoom: 58, near: 0.1, far: 100 }}
      fallback={<div className="world-fallback">3D preview unavailable. Station controls and confirmed state remain available below.</div>}
    >
      <World snapshot={snapshot} reducedMotion={reducedMotion} />
    </Canvas>
    <div className="world-status" aria-hidden="true">
      <span>{snapshot.currentOrder ? snapshot.currentOrder.dishName : "Kitchen ready"}</span>
      <strong>{orderState}</strong>
    </div>
    {preview && <div className="world-legend" aria-hidden="true"><span><i className="legend-dot active" /> Capacity online</span><span><i className="legend-dot cooking" /> Cooking now</span></div>}
  </div>;
}

export function PreviewKitchenWorld() {
  return <KitchenWorld snapshot={PREVIEW_SNAPSHOT} preview />;
}

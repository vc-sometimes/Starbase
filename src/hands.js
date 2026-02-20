import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

let handLandmarker = null;
let video = null;
let canvas = null;
let ctx = null;
let running = false;
let onGesture = null;

const LERP = 0.25;

// Per-hand state (keyed by 'left' / 'right')
const handState = {
  left:  { smoothX: 0.5, smoothY: 0.5, smoothPinch: 1, smoothKnobAngle: 0, smoothHandSize: 0.25, prevKnobAngle: null, wasPinching: false, activated: false },
  right: { smoothX: 0.5, smoothY: 0.5, smoothPinch: 1, smoothKnobAngle: 0, smoothHandSize: 0.25, prevKnobAngle: null, wasPinching: false, activated: false },
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function isPalmUp(lm, handedness) {
  const wrist = lm[0];
  const middleMcp = lm[9];

  if (wrist.y < middleMcp.y) return false;

  const fingers = [
    { tip: lm[8],  pip: lm[6] },
    { tip: lm[12], pip: lm[10] },
    { tip: lm[16], pip: lm[14] },
    { tip: lm[20], pip: lm[18] },
  ];

  let extended = 0;
  for (const f of fingers) {
    if (f.tip.y < f.pip.y) extended++;
  }
  if (extended < 3) return false;

  const indexMcp = lm[5];
  const pinkyMcp = lm[17];
  const ax = indexMcp.x - wrist.x;
  const ay = indexMcp.y - wrist.y;
  const bx = pinkyMcp.x - wrist.x;
  const by = pinkyMcp.y - wrist.y;
  const cross = ax * by - ay * bx;

  const label = handedness?.[0]?.categoryName || 'Right';
  const palmFacing = label === 'Right' ? cross < 0 : cross > 0;

  return palmFacing;
}

export async function initHands(gestureCallback) {
  onGesture = gestureCallback;

  video = document.createElement('video');
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.style.display = 'none';
  document.body.appendChild(video);

  canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 150;
  Object.assign(canvas.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    width: '200px',
    height: '150px',
    border: '1px dashed #2a2a2a',
    background: '#0e0e0e',
    zIndex: '1000',
    transform: 'scaleX(-1)',
    opacity: '0.7',
  });
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
  });
  video.srcObject = stream;
  await video.play();

  running = true;
  handState.left.activated = false;
  handState.right.activated = false;
  detect();
}

function processHand(lm, handedness, yOffset) {
  const label = handedness?.[0]?.categoryName || 'Right';
  // MediaPipe "Right" from camera = user's left hand
  const isLeftHand = label === 'Right';
  const key = isLeftHand ? 'left' : 'right';
  const st = handState[key];

  // Draw landmarks
  ctx.fillStyle = st.activated ? '#666' : '#333';
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  const palmUp = isPalmUp(lm, handedness);
  if (palmUp && !st.activated) st.activated = true;

  if (!st.activated) {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.fillStyle = '#444';
    ctx.font = '10px monospace';
    ctx.fillText(`${isLeftHand ? 'L' : 'R'}: SHOW PALM`, -canvas.width + 4, yOffset);
    ctx.restore();
    return null;
  }

  const thumbTip = lm[4];
  const indexTip = lm[8];
  const middleTip = lm[12];
  const wrist = lm[0];

  const palmX = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
  const palmY = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;

  const handSize = dist(wrist, middleTip);
  const pinchDist = dist(thumbTip, indexTip) / handSize;

  st.smoothX = lerp(st.smoothX, palmX, LERP);
  st.smoothY = lerp(st.smoothY, palmY, LERP);
  st.smoothPinch = lerp(st.smoothPinch, pinchDist, LERP);
  st.smoothHandSize = lerp(st.smoothHandSize, handSize, LERP);

  // Hysteresis: tighter threshold to enter pinch, looser to exit
  const PINCH_ENTER = 0.22;
  const PINCH_EXIT = 0.32;
  const isPinching = st.wasPinching
    ? st.smoothPinch < PINCH_EXIT
    : st.smoothPinch < PINCH_ENTER;

  // Hand tilt
  const middleMcp = lm[9];
  const dx = middleMcp.x - wrist.x;
  const dy = middleMcp.y - wrist.y;
  const handTiltX = Math.atan2(dx, -dy);
  const dz = middleMcp.z - wrist.z;
  const handLen = Math.sqrt(dx * dx + dy * dy);
  const handTiltY = Math.atan2(dz, handLen);

  // Knob angle
  const knobAngle = Math.atan2(indexTip.y - thumbTip.y, indexTip.x - thumbTip.x);
  st.smoothKnobAngle = lerp(st.smoothKnobAngle, knobAngle, 0.3);

  let knobDelta = 0;
  if (isPinching) {
    if (st.wasPinching && st.prevKnobAngle !== null) {
      knobDelta = angleDelta(st.smoothKnobAngle, st.prevKnobAngle);
    }
    st.prevKnobAngle = st.smoothKnobAngle;
  } else {
    st.prevKnobAngle = null;
  }
  st.wasPinching = isPinching;

  // Draw pinch line
  ctx.strokeStyle = isPinching ? '#888' : '#333';
  ctx.lineWidth = isPinching ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(thumbTip.x * canvas.width, thumbTip.y * canvas.height);
  ctx.lineTo(indexTip.x * canvas.width, indexTip.y * canvas.height);
  ctx.stroke();

  // Draw knob indicator when pinching
  if (isPinching) {
    const midX = (thumbTip.x + indexTip.x) / 2 * canvas.width;
    const midY = (thumbTip.y + indexTip.y) / 2 * canvas.height;
    ctx.beginPath();
    ctx.arc(midX, midY, 12, 0, Math.PI * 2);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(midX, midY);
    ctx.lineTo(midX + Math.cos(st.smoothKnobAngle) * 12, midY + Math.sin(st.smoothKnobAngle) * 12);
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Status
  const hand = isLeftHand ? 'L' : 'R';
  const modeText = isPinching
    ? (isLeftHand ? 'L-PINCH: TWIST ZOOM' : 'R-PINCH: PAN')
    : `${hand}-OPEN: ROTATE`;
  ctx.save();
  ctx.scale(-1, 1);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText(modeText, -canvas.width + 4, yOffset);
  ctx.restore();

  return {
    panX: (st.smoothX - 0.5) * 2,
    panY: -(st.smoothY - 0.5) * 2,
    isPinching,
    knobDelta,
    handSize: st.smoothHandSize,
    isLeftHand,
    isRightHand: !isLeftHand,
    detected: true,
  };
}

function detect() {
  if (!running) return;

  const now = performance.now();
  const results = handLandmarker.detectForVideo(video, now);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (results.landmarks && results.landmarks.length > 0) {
    for (let i = 0; i < results.landmarks.length; i++) {
      const lm = results.landmarks[i];
      const handedness = results.handednesses?.[i];
      const yOffset = 12 + i * 14;

      const gesture = processHand(lm, handedness, yOffset);
      if (gesture && onGesture) {
        onGesture(gesture);
      }
    }
  } else {
    // Reset both hands
    handState.left.activated = false;
    handState.left.prevKnobAngle = null;
    handState.left.wasPinching = false;
    handState.right.activated = false;
    handState.right.prevKnobAngle = null;
    handState.right.wasPinching = false;

    ctx.save();
    ctx.scale(-1, 1);
    ctx.fillStyle = '#333';
    ctx.font = '10px monospace';
    ctx.fillText('NO HAND', -canvas.width + 4, 12);
    ctx.restore();

    if (onGesture) {
      onGesture({ detected: false });
    }
  }

  requestAnimationFrame(detect);
}

export function stopHands() {
  running = false;
  for (const key of ['left', 'right']) {
    handState[key].activated = false;
    handState[key].prevKnobAngle = null;
    handState[key].wasPinching = false;
  }
  if (video && video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
  }
  if (canvas) canvas.remove();
  if (video) video.remove();
}

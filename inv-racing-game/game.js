(function () {
  "use strict";

  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");

  const TRACK_WIDTH = 110;
  const LAPS_TO_FINISH = 5;
  const PLAYER_MAX_SPEED = 200;

  const state = {
    mode: "racing",
    elapsed: 0,
    raceFinished: false,
    keys: {
      left: false,
      right: false,
      accelerate: false,
    },
    track: null,
    player: null,
    aiCars: [],
    camera: { x: 0, y: 0 },
    impacts: 0,
    courseOutEvents: 0,
  };

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function wrapDistance(a, b, loopLength) {
    const half = loopLength * 0.5;
    let d = ((a - b) % loopLength + loopLength) % loopLength;
    if (d > half) d -= loopLength;
    return d;
  }

  function makeTrack() {
    const controls = [
      { x: -560, y: -40 },
      { x: -430, y: -230 },
      { x: -220, y: -260 },
      { x: -40, y: -120 },
      { x: 150, y: -260 },
      { x: 340, y: -220 },
      { x: 560, y: -20 },
      { x: 520, y: 200 },
      { x: 320, y: 330 },
      { x: 100, y: 260 },
      { x: -110, y: 350 },
      { x: -340, y: 300 },
      { x: -520, y: 130 },
    ];

    const samples = [];
    const sampleCountPerSpan = 28;
    const n = controls.length;

    function catmull(p0, p1, p2, p3, t) {
      const t2 = t * t;
      const t3 = t2 * t;
      return {
        x:
          0.5 *
          ((2 * p1.x) +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          ((2 * p1.y) +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      };
    }

    for (let i = 0; i < n; i++) {
      const p0 = controls[(i - 1 + n) % n];
      const p1 = controls[i];
      const p2 = controls[(i + 1) % n];
      const p3 = controls[(i + 2) % n];
      for (let j = 0; j < sampleCountPerSpan; j++) {
        const t = j / sampleCountPerSpan;
        samples.push(catmull(p0, p1, p2, p3, t));
      }
    }

    const cumulative = [0];
    for (let i = 1; i < samples.length; i++) {
      const dx = samples[i].x - samples[i - 1].x;
      const dy = samples[i].y - samples[i - 1].y;
      cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
    }
    const dx0 = samples[0].x - samples[samples.length - 1].x;
    const dy0 = samples[0].y - samples[samples.length - 1].y;
    const closeLength = Math.hypot(dx0, dy0);
    const length = cumulative[cumulative.length - 1] + closeLength;

    return { samples, cumulative, length, closeLength };
  }

  function sampleTrackAtS(track, s) {
    const len = track.length;
    let sWrapped = s % len;
    if (sWrapped < 0) sWrapped += len;

    const cumulative = track.cumulative;
    const samples = track.samples;
    let idx = 0;
    while (idx + 1 < cumulative.length && cumulative[idx + 1] <= sWrapped) {
      idx += 1;
    }

    let nextIdx = idx + 1;
    let segStart = cumulative[idx];
    let segLen;

    if (nextIdx < samples.length) {
      segLen = cumulative[nextIdx] - segStart;
    } else {
      nextIdx = 0;
      segLen = track.closeLength;
    }

    const a = samples[idx];
    const b = samples[nextIdx];
    const t = segLen > 0.0001 ? (sWrapped - segStart) / segLen : 0;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;

    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const mag = Math.max(0.0001, Math.hypot(tx, ty));
    const tangent = { x: tx / mag, y: ty / mag };
    const normal = { x: -tangent.y, y: tangent.x };
    const heading = Math.atan2(tangent.y, tangent.x);

    return { x, y, tangent, normal, heading };
  }

  function nearestTrackDistance(track, px, py, hintS) {
    const samples = track.samples;
    const count = samples.length;
    const len = track.length;
    const hint = Math.floor((((hintS % len) + len) % len) / len * count);

    let bestI = 0;
    let bestDist2 = Infinity;
    const searchRadius = 50;

    for (let d = -searchRadius; d <= searchRadius; d++) {
      const i = (hint + d + count) % count;
      const sp = samples[i];
      const dx = px - sp.x;
      const dy = py - sp.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        bestI = i;
      }
    }

    const center = samples[bestI];
    const next = samples[(bestI + 1) % count];
    const tx = next.x - center.x;
    const ty = next.y - center.y;
    const mag = Math.max(0.0001, Math.hypot(tx, ty));
    const tangent = { x: tx / mag, y: ty / mag };
    const normal = { x: -tangent.y, y: tangent.x };
    const rx = px - center.x;
    const ry = py - center.y;
    const lateral = rx * normal.x + ry * normal.y;

    return {
      distance: Math.sqrt(bestDist2),
      lateral,
      sApprox: (bestI / count) * len,
    };
  }

  function makeCar(id, category, s, laneOffset) {
    const point = sampleTrackAtS(state.track, s);
    return {
      id,
      category,
      s,
      laneOffset,
      laneVelocity: 0,
      x: point.x + point.normal.x * laneOffset,
      y: point.y + point.normal.y * laneOffset,
      heading: point.heading,
      speedBase: category === 1 ? 206 + Math.random() * 18 : 165 + Math.random() * 16,
      speed: 0,
      traveled: 0,
      laps: 0,
      finished: false,
      finishTime: Infinity,
      offTrack: false,
      collideCooldown: 0,
      autoBrakeTimer: 0,
      aiBrakeTimer: 0,
      lineBias: 0,
      weaveAmp: 0,
      weaveFreq: 0,
      weavePhase: 0,
      lineResponsiveness: 0,
      speedJitterAmp: 0,
      speedJitterFreq: 0,
      speedJitterPhase: 0,
      laneShiftTarget: laneOffset,
      laneShiftTimer: 0,
      laneShiftHoldTimer: 0,
      blockDecisionTimer: 0,
      blockTimer: 0,
      blockOffset: 0,
    };
  }

  function rankCategory2() {
    const racers = [state.player, ...state.aiCars].filter((c) => c.category === 2);
    const now = state.elapsed;
    racers.sort((a, b) => {
      const aMetric = a.finished
        ? a.finishTime
        : now + (LAPS_TO_FINISH * state.track.length - a.traveled) / Math.max(a.speedBase, 40);
      const bMetric = b.finished
        ? b.finishTime
        : now + (LAPS_TO_FINISH * state.track.length - b.traveled) / Math.max(b.speedBase, 40);
      return aMetric - bMetric;
    });
    return racers.findIndex((r) => r.id === "player") + 1;
  }

  function resetGame() {
    state.track = makeTrack();
    state.elapsed = 0;
    state.raceFinished = false;
    state.mode = "racing";
    state.impacts = 0;
    state.courseOutEvents = 0;

    state.player = makeCar("player", 2, 0, -8);
    state.player.speed = 95;
    state.player.speedBase = 188;

    state.aiCars = [];
    const totalCars = 20;
    const trackLen = state.track.length;
    const randomStarts = [];
    const binSize = trackLen / totalCars;
    for (let i = 0; i < totalCars; i++) {
      let s = i * binSize + Math.random() * binSize;
      const nearPlayerStart = Math.abs(wrapDistance(s, 0, trackLen)) < 180;
      if (nearPlayerStart) s = (s + trackLen * 0.33) % trackLen;
      randomStarts.push(s);
    }
    for (let i = randomStarts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = randomStarts[i];
      randomStarts[i] = randomStarts[j];
      randomStarts[j] = t;
    }

    for (let i = 0; i < totalCars; i++) {
      const category = i < 10 ? 1 : 2;
      const s = randomStarts[i];
      const laneOffset = Math.random() * 78 - 39;
      const car = makeCar("ai-" + i, category, s, laneOffset);
      car.speed = car.speedBase + (Math.random() * 8 - 4);
      car.lineBias = Math.random() * 76 - 38;
      car.weaveAmp = 4 + Math.random() * 14;
      car.weaveFreq = 0.35 + Math.random() * 0.95;
      car.weavePhase = Math.random() * Math.PI * 2;
      car.lineResponsiveness = 0.5 + Math.random() * 0.9;
      car.speedJitterAmp = 2 + Math.random() * 12;
      car.speedJitterFreq = 0.28 + Math.random() * 0.8;
      car.speedJitterPhase = Math.random() * Math.PI * 2;
      car.laneShiftTimer = 1.2 + Math.random() * 2.8;
      car.laneShiftHoldTimer = 0;
      car.laneShiftTarget = car.lineBias;
      car.blockDecisionTimer = 0.9 + Math.random() * 2.4;
      car.blockTimer = 0;
      car.blockOffset = Math.random() * 24 - 12;
      state.aiCars.push(car);
    }

    state.camera.x = state.player.x;
    state.camera.y = state.player.y;
  }

  function updatePlayer(dt) {
    const p = state.player;
    if (p.finished) return;

    p.collideCooldown = Math.max(0, p.collideCooldown - dt);
    p.autoBrakeTimer = Math.max(0, p.autoBrakeTimer - dt);

    const turn = (state.keys.left ? -1 : 0) + (state.keys.right ? 1 : 0);
    p.laneVelocity += turn * 240 * dt;
    p.laneVelocity *= 0.9;
    p.laneOffset += p.laneVelocity * dt;

    const accel = state.keys.accelerate ? 140 : -105;
    p.speed = clamp(p.speed + accel * dt, 40, PLAYER_MAX_SPEED);

    if (p.autoBrakeTimer > 0) {
      p.speed = Math.min(p.speed, 90);
      p.speed *= 0.93;
    }

    p.s += p.speed * dt;
    p.traveled += p.speed * dt;
    p.laps = Math.floor(p.traveled / state.track.length);

    const center = sampleTrackAtS(state.track, p.s);
    p.x = center.x + center.normal.x * p.laneOffset;
    p.y = center.y + center.normal.y * p.laneOffset;
    p.heading = center.heading;

    const offTrack = Math.abs(p.laneOffset) > TRACK_WIDTH * 0.5;
    if (offTrack) {
      if (!p.offTrack) state.courseOutEvents += 1;
      p.offTrack = true;
      p.speed *= 0.95;
    } else {
      p.offTrack = false;
    }

    if (p.laps >= LAPS_TO_FINISH) {
      p.finished = true;
      p.finishTime = state.elapsed;
      p.speed = 0;
      state.raceFinished = true;
      state.mode = "finished";
    }
  }

  function updateAi(dt) {
    for (const car of state.aiCars) {
      car.collideCooldown = Math.max(0, car.collideCooldown - dt);
      car.aiBrakeTimer = Math.max(0, car.aiBrakeTimer - dt);
      car.laneShiftTimer = Math.max(0, car.laneShiftTimer - dt);
      car.laneShiftHoldTimer = Math.max(0, car.laneShiftHoldTimer - dt);
      car.blockDecisionTimer = Math.max(0, car.blockDecisionTimer - dt);
      car.blockTimer = Math.max(0, car.blockTimer - dt);

      if (car.category === 2 && car.blockDecisionTimer <= 0) {
        if (Math.random() < 0.34) {
          car.blockTimer = 1.0 + Math.random() * 1.8;
          car.blockOffset = Math.random() * 28 - 14;
        }
        car.blockDecisionTimer = 1.3 + Math.random() * 2.7;
      } else if (car.category !== 2) {
        car.blockTimer = 0;
      }

      if (car.laneShiftTimer <= 0) {
        car.laneShiftTarget = clamp(car.lineBias + (Math.random() * 2 - 1) * 38, -48, 48);
        car.laneShiftHoldTimer = 0.45 + Math.random() * 1.2;
        car.laneShiftTimer = 1.8 + Math.random() * 3.4;
      }
      if (car.laneShiftHoldTimer <= 0) {
        car.laneShiftTarget += (car.lineBias - car.laneShiftTarget) * Math.min(1, dt * 2.2);
      }

      const laneWave = Math.sin(state.elapsed * car.weaveFreq + car.weavePhase) * car.weaveAmp;
      const cornerBias = Math.sin(car.s * 0.007 + car.weavePhase * 0.5) * 7;
      let laneTarget = car.laneShiftTarget + laneWave + cornerBias;
      let laneResponse = car.lineResponsiveness;

      const playerGap = Math.abs(wrapDistance(car.s, state.player.s, state.track.length));
      if (car.category === 2 && !state.player.finished && car.blockTimer > 0 && playerGap < 260) {
        laneTarget = clamp(state.player.laneOffset + car.blockOffset, -52, 52);
        laneResponse += 0.7;
      }

      car.laneOffset += (laneTarget - car.laneOffset) * laneResponse * dt;

      const speedJitter =
        Math.sin(state.elapsed * car.speedJitterFreq + car.speedJitterPhase) * car.speedJitterAmp;
      car.speed = car.speedBase + speedJitter;
      if (car.aiBrakeTimer > 0) {
        car.speed = Math.min(car.speed, car.speedBase * 0.58);
        car.speed *= 0.9;
      }
      car.s += car.speed * dt;
      car.traveled += car.speed * dt;
      car.laps = Math.floor(car.traveled / state.track.length);

      const center = sampleTrackAtS(state.track, car.s);
      car.x = center.x + center.normal.x * car.laneOffset;
      car.y = center.y + center.normal.y * car.laneOffset;
      car.heading = center.heading;

      if (car.laps >= LAPS_TO_FINISH && !car.finished) {
        car.finished = true;
        car.finishTime = state.elapsed;
      }
    }
  }

  function updateAiCollisions() {
    const cars = state.aiCars;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        if (a.collideCooldown > 0 || b.collideCooldown > 0) continue;

        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < 18 * 18) {
          a.aiBrakeTimer = Math.max(a.aiBrakeTimer, 0.8);
          b.aiBrakeTimer = Math.max(b.aiBrakeTimer, 0.8);
          a.collideCooldown = 0.45;
          b.collideCooldown = 0.45;
          a.laneOffset += (Math.random() * 2 - 1) * 7;
          b.laneOffset += (Math.random() * 2 - 1) * 7;
        }
      }
    }
  }

  function updateCollisions() {
    const p = state.player;
    if (p.finished) return;

    for (const ai of state.aiCars) {
      const dx = p.x - ai.x;
      const dy = p.y - ai.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < 19 * 19 && p.collideCooldown <= 0) {
        p.autoBrakeTimer = 1.1;
        p.speed *= 0.65;
        p.laneOffset += (Math.random() < 0.5 ? -1 : 1) * 16;
        p.collideCooldown = 0.45;
        state.impacts += 1;
      }
    }
  }

  function updateCamera(dt) {
    const follow = 1 - Math.exp(-dt * 6.5);
    state.camera.x += (state.player.x - state.camera.x) * follow;
    state.camera.y += (state.player.y - state.camera.y) * follow;
  }

  function update(dt) {
    if (!state.raceFinished) {
      state.elapsed += dt;
      updatePlayer(dt);
      updateAi(dt);
      updateCollisions();
      updateAiCollisions();
      const nearest = nearestTrackDistance(state.track, state.player.x, state.player.y, state.player.s);
      if (Math.abs(nearest.lateral) > TRACK_WIDTH * 0.5) {
        state.player.offTrack = true;
      }
    }
    updateCamera(dt);
  }

  function drawTrack() {
    const track = state.track;
    const pts = track.samples;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = "#626262";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = TRACK_WIDTH;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = "#f3efde";
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 12]);
    ctx.stroke();
    ctx.setLineDash([]);

    const start = sampleTrackAtS(track, 0);
    ctx.save();
    ctx.translate(start.x, start.y);
    ctx.rotate(start.heading + Math.PI / 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(-44, -6, 88, 12);
    ctx.fillStyle = "#1f1f1f";
    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) ctx.fillRect(-44 + i * 15, -6, 15, 12);
    }
    ctx.restore();
  }

  function drawCar(car, color) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);
    ctx.fillStyle = color;
    ctx.fillRect(-10, -6, 20, 12);
    ctx.fillStyle = "#111";
    ctx.fillRect(-8, -5, 4, 3);
    ctx.fillRect(4, -5, 4, 3);
    ctx.fillRect(-8, 2, 4, 3);
    ctx.fillRect(4, 2, 4, 3);
    ctx.restore();
  }

  function drawHud() {
    const p = state.player;
    const lapNow = Math.min(LAPS_TO_FINISH, p.laps + 1);
    const rank = rankCategory2();
    const totalTime = state.elapsed;
    const win = rank === 1;

    ctx.fillStyle = "rgba(8, 18, 8, 0.72)";
    ctx.fillRect(16, 14, 360, 152);
    ctx.strokeStyle = "#d7e5b7";
    ctx.strokeRect(16, 14, 360, 152);

    ctx.fillStyle = "#f1f5e6";
    ctx.font = "18px Trebuchet MS, sans-serif";
    ctx.fillText("CIRCUIT RACE (" + LAPS_TO_FINISH + " LAPS)", 28, 40);
    ctx.font = "15px Trebuchet MS, sans-serif";
    ctx.fillText("Steer: Left/Right  |  Throttle: Space", 28, 64);
    ctx.fillText("Lap: " + lapNow + " / " + LAPS_TO_FINISH, 28, 88);
    ctx.fillText("Time: " + totalTime.toFixed(2) + " s", 28, 112);
    ctx.fillText("Category 2 Rank: " + rank, 28, 136);
    ctx.fillText("Auto Brake: " + (p.autoBrakeTimer > 0 ? "ON" : "OFF"), 28, 160);

    if (state.raceFinished) {
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(canvas.width * 0.5 - 250, canvas.height * 0.5 - 72, 500, 144);
      ctx.strokeStyle = "#fcf2bf";
      ctx.strokeRect(canvas.width * 0.5 - 250, canvas.height * 0.5 - 72, 500, 144);
      ctx.fillStyle = "#fff8ce";
      ctx.font = "34px Trebuchet MS, sans-serif";
      ctx.fillText(win ? "CATEGORY 2 WINNER" : "CATEGORY 2 DEFEAT", canvas.width * 0.5 - 180, canvas.height * 0.5 - 15);
      ctx.font = "24px Trebuchet MS, sans-serif";
      ctx.fillText("Final Time: " + p.finishTime.toFixed(2) + " s", canvas.width * 0.5 - 120, canvas.height * 0.5 + 25);
      ctx.font = "16px Trebuchet MS, sans-serif";
      ctx.fillText("Press R to restart", canvas.width * 0.5 - 65, canvas.height * 0.5 + 52);
    }
  }

  function render() {
    ctx.fillStyle = "#7ea86c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width * 0.5 - state.camera.x, canvas.height * 0.5 - state.camera.y);
    drawTrack();

    for (const car of state.aiCars) {
      drawCar(car, car.category === 1 ? "#f25f42" : "#ffd447");
    }
    drawCar(state.player, state.player.offTrack ? "#4ec9ff" : "#2b8cff");

    ctx.restore();

    drawHud();
  }

  function fitCanvasToCssSize() {
    const rect = canvas.getBoundingClientRect();
    const nextW = Math.max(960, Math.floor(rect.width));
    const nextH = Math.max(600, Math.floor(rect.height));
    if (nextW !== canvas.width || nextH !== canvas.height) {
      canvas.width = nextW;
      canvas.height = nextH;
      resetGame();
    }
  }

  let lastTs = 0;
  function frame(ts) {
    if (!lastTs) lastTs = ts;
    const dt = clamp((ts - lastTs) / 1000, 0, 0.034);
    lastTs = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  function renderGameToText() {
    const p = state.player;
    const rank = rankCategory2();
    const payload = {
      coordinateSystem: "world origin=(0,0) at track center-area, +x right, +y down; camera centers near player",
      mode: state.mode,
      elapsed: Number(state.elapsed.toFixed(3)),
      lapsToFinish: LAPS_TO_FINISH,
      track: {
        width: TRACK_WIDTH,
        length: Number(state.track.length.toFixed(2)),
      },
      camera: {
        x: Number(state.camera.x.toFixed(1)),
        y: Number(state.camera.y.toFixed(1)),
      },
      player: {
        category: p.category,
        x: Number(p.x.toFixed(1)),
        y: Number(p.y.toFixed(1)),
        s: Number(p.s.toFixed(2)),
        laneOffset: Number(p.laneOffset.toFixed(2)),
        speed: Number(p.speed.toFixed(2)),
        heading: Number(p.heading.toFixed(3)),
        lapsCompleted: p.laps,
        totalRaceTime: Number(state.elapsed.toFixed(3)),
        autoBrakeTimer: Number(p.autoBrakeTimer.toFixed(2)),
        offTrack: p.offTrack,
        finished: p.finished,
      },
      category2Rank: rank,
      impacts: state.impacts,
      courseOutEvents: state.courseOutEvents,
      aiCars: state.aiCars.map((c) => ({
        id: c.id,
        category: c.category,
        x: Number(c.x.toFixed(1)),
        y: Number(c.y.toFixed(1)),
        s: Number(c.s.toFixed(2)),
        lapsCompleted: c.laps,
        finished: c.finished,
      })),
    };
    return JSON.stringify(payload);
  }

  window.render_game_to_text = renderGameToText;
  window.advanceTime = function advanceTime(ms) {
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    const dt = ms / steps / 1000;
    for (let i = 0; i < steps; i++) update(dt);
    render();
    return Promise.resolve(true);
  };

  window.addEventListener("keydown", (e) => {
    if (e.code === "ArrowLeft") state.keys.left = true;
    if (e.code === "ArrowRight") state.keys.right = true;
    if (e.code === "Space") state.keys.accelerate = true;
    if (e.code === "KeyR" && state.raceFinished) resetGame();
    if (e.code === "KeyF") {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "ArrowLeft") state.keys.left = false;
    if (e.code === "ArrowRight") state.keys.right = false;
    if (e.code === "Space") state.keys.accelerate = false;
  });

  window.addEventListener("resize", fitCanvasToCssSize);
  document.addEventListener("fullscreenchange", fitCanvasToCssSize);

  fitCanvasToCssSize();
  resetGame();
  requestAnimationFrame(frame);
})();

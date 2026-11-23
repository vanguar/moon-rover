import type { WorldId } from '../world';
import { buildLrvModel, LRV_WHEELS } from './model';
import type { RoverModel } from './models/kit';
import { buildLunokhodModel, LUNOKHOD_AXLE, LUNOKHOD_R, LUNOKHOD_WHEELS } from './models/lunokhod';
import { buildMslModel, MSL_AXLE, MSL_WHEELS } from './models/msl';
import { buildSojournerModel, SOJOURNER_AXLE, SOJOURNER_R, SOJOURNER_WHEELS } from './models/sojourner';
import { buildYutuModel, YUTU_AXLE, YUTU_R, YUTU_WHEELS } from './models/yutu';
import { buildZhurongModel, ZHURONG_AXLE, ZHURONG_R, ZHURONG_WHEELS } from './models/zhurong';

export type RoverId = 'lrv' | 'lunokhod' | 'yutu2' | 'sojourner' | 'curiosity' | 'perseverance' | 'zhurong';

/** Part of a photo that is animated on the selection card (coordinates in 0..1 of the cropped photo). */
export type PhotoPart =
  /** Wheel: ellipse (cx, cy, rx, ry, tilt) whose content rotates. */
  | { kind: 'spin'; cx: number; cy: number; rx: number; ry: number; tilt?: number; speed?: number }
  /** Rigid part rotating about a pivot inside a polygon (antenna, mast, lid). */
  | { kind: 'sway'; poly: [number, number][]; px: number; py: number; amp: number; period: number }
  /** Specular glint sweeping across a polygon (solar panels, foil). */
  | { kind: 'glint'; poly: [number, number][]; period: number };

export interface RoverSpec {
  id: RoverId;
  world: WorldId;
  country: 'usa' | 'ussr' | 'china';
  year: number;
  /** Wheel centres (x left, z forward) in the chassis frame. */
  wheels: [number, number][];
  wheelRadius: number;
  wheelWidth: number;
  axleY: number;
  travel: number;
  /** Fully loaded mass, kg. */
  mass: number;
  /** Chassis collider half-extents and offset (body box). */
  body: { half: [number, number, number]; offset: [number, number, number]; inertia?: [number, number, number] };
  /** Massless upper volume the rover rests on when it is upside down. */
  top: { half: [number, number, number]; offset: [number, number, number] };
  /** Steering angle factor per wheel (front +1, rear −1, fixed 0). */
  steer: number[];
  maxSteer: number;
  /** Skid steering (Lunokhod): no steerable wheels, left/right sides driven differentially. */
  skid?: boolean;
  /** Game top speed, m/s (real rovers are far slower — see `real.speedKmh`). */
  maxSpeed: number;
  batteryWh: number;
  idleW: number;
  solarW: number;
  lightsW: number;
  /** Wheels that leave visible ruts. */
  trackWheels: number[];
  tread: 'chevron' | 'grouser' | 'cleat';
  /** Crew on board (LRV) or a remote-driven robot seen through its cameras. */
  crew: boolean;
  build(): RoverModel;
  photo: { file: string; credit: string; license: string; url: string; parts: PhotoPart[] };
  /** Real-mission facts; distance only for completed missions (active rovers keep driving). */
  real: { massKg: number; lengthM: number; speedKmh: number; wheels: number; power: string; distanceKm?: number };
}

const fill = (n: number, v: number) => new Array(n).fill(v);

export const ROVERS: Record<RoverId, RoverSpec> = {
  lrv: {
    id: 'lrv', world: 'moon', country: 'usa', year: 1971,
    wheels: LRV_WHEELS,
    wheelRadius: 0.41, wheelWidth: 0.23, axleY: -0.35, travel: 0.15, mass: 620,
    body: { half: [0.7, 0.2, 1.6], offset: [0, 0, 0], inertia: [560, 740, 230] },
    top: { half: [0.85, 0.45, 0.75], offset: [0, 0.62, -0.2] },
    steer: [1, 1, -1, -1], maxSteer: 0.45, maxSpeed: 5.0,
    batteryWh: 1500, idleW: 60, solarW: 600, lightsW: 60,
    trackWheels: [0, 1, 2, 3], tread: 'chevron', crew: true, build: buildLrvModel,
    photo: {
      file: 'lrv.jpg', credit: 'NASA / David R. Scott (AS15-88-11866)', license: 'Public domain',
      url: 'https://commons.wikimedia.org/wiki/File:Apollo_15_flag,_rover,_LM,_Irwin.jpg', parts: [
        { kind: 'sway', poly: [[0.63, 0], [1, 0], [1, 0.3], [0.63, 0.18]], px: 0.8, py: 0.24, amp: 0.05, period: 7 },
        { kind: 'sway', poly: [[0.5, 0.47], [0.64, 0.47], [0.64, 0.64], [0.5, 0.64]], px: 0.58, py: 0.62, amp: 0.07, period: 5 },
        { kind: 'glint', poly: [[0.48, 0.5], [0.87, 0.5], [0.87, 0.72], [0.48, 0.72]], period: 6 },
      ],
    },
    real: { massKg: 210, lengthM: 3.1, speedKmh: 18, wheels: 4, power: '2 × 36 V Ag-Zn', distanceKm: 27.8 },
  },
  lunokhod: {
    id: 'lunokhod', world: 'moon', country: 'ussr', year: 1970,
    wheels: LUNOKHOD_WHEELS, wheelRadius: LUNOKHOD_R, wheelWidth: 0.2, axleY: LUNOKHOD_AXLE, travel: 0.1, mass: 756,
    body: { half: [0.75, 0.38, 1.15], offset: [0, 0.3, 0] },
    top: { half: [0.6, 0.3, 0.8], offset: [0, 0.85, 0] },
    steer: fill(8, 0), maxSteer: 0, skid: true, maxSpeed: 2.8,
    batteryWh: 2400, idleW: 140, solarW: 1000, lightsW: 50,
    trackWheels: [0, 1, 6, 7], tread: 'grouser', crew: false, build: buildLunokhodModel,
    photo: {
      file: 'lunokhod.jpg', credit: 'Armael (Wikimedia Commons), Lunokhod-1 at the Musée de l\'Air et de l\'Espace', license: 'CC0',
      url: 'https://commons.wikimedia.org/wiki/File:Lunokhod_1_moon_rover_(MMA_2011)_(2).JPG', parts: [
        { kind: 'spin', cx: 0.48, cy: 0.81, rx: 0.093, ry: 0.17, speed: 0.6 },
        { kind: 'spin', cx: 0.645, cy: 0.7, rx: 0.072, ry: 0.135, speed: 0.6 },
        { kind: 'spin', cx: 0.755, cy: 0.6, rx: 0.062, ry: 0.115, speed: 0.6 },
        { kind: 'spin', cx: 0.84, cy: 0.52, rx: 0.052, ry: 0.1, speed: 0.6 },
        { kind: 'spin', cx: 0.128, cy: 0.585, rx: 0.075, ry: 0.13, speed: 0.6 },
        { kind: 'sway', poly: [[0.7, 0.15], [0.98, 0.15], [0.98, 0.36], [0.7, 0.3]], px: 0.72, py: 0.22, amp: 0.05, period: 6 },
        { kind: 'glint', poly: [[0.25, 0.08], [0.5, 0.03], [0.84, 0.09], [0.7, 0.17], [0.3, 0.17]], period: 5 },
      ],
    },
    real: { massKg: 756, lengthM: 4.42, speedKmh: 2, wheels: 8, power: 'Solar + Po-210 heater', distanceKm: 10.5 },
  },
  yutu2: {
    id: 'yutu2', world: 'moon', country: 'china', year: 2019,
    wheels: YUTU_WHEELS, wheelRadius: YUTU_R, wheelWidth: 0.15, axleY: YUTU_AXLE, travel: 0.06, mass: 140,
    body: { half: [0.38, 0.21, 0.48], offset: [0, 0.21, 0] },
    top: { half: [0.3, 0.2, 0.3], offset: [0, 0.6, 0.2] },
    steer: [1, 1, 0, 0, -1, -1], maxSteer: 0.6, maxSpeed: 1.4,
    batteryWh: 600, idleW: 40, solarW: 220, lightsW: 25,
    trackWheels: [0, 1, 4, 5], tread: 'grouser', crew: false, build: buildYutuModel,
    photo: {
      file: 'yutu2.jpg', credit: 'CNSA / CLEP (via IAU)', license: 'CC BY 4.0',
      url: 'https://commons.wikimedia.org/wiki/File:Yutu-2_leaving_Chang_e-4-iau1901a.jpg', parts: [
        { kind: 'sway', poly: [[0.52, 0.18], [0.64, 0.18], [0.64, 0.48], [0.52, 0.48]], px: 0.6, py: 0.47, amp: 0.06, period: 6 },
        { kind: 'glint', poly: [[0.32, 0.47], [0.62, 0.46], [0.69, 0.6], [0.34, 0.63]], period: 4.5 },
        { kind: 'spin', cx: 0.35, cy: 0.84, rx: 0.025, ry: 0.05, speed: 1 },
        { kind: 'spin', cx: 0.63, cy: 0.8, rx: 0.025, ry: 0.05, speed: 1 },
      ],
    },
    real: { massKg: 135, lengthM: 1.5, speedKmh: 0.2, wheels: 6, power: 'Solar + RHU' },
  },
  sojourner: {
    id: 'sojourner', world: 'mars', country: 'usa', year: 1997,
    wheels: SOJOURNER_WHEELS, wheelRadius: SOJOURNER_R, wheelWidth: 0.079, axleY: SOJOURNER_AXLE, travel: 0.03, mass: 11.5,
    body: { half: [0.15, 0.06, 0.22], offset: [0, 0.06, 0] },
    top: { half: [0.2, 0.03, 0.28], offset: [0, 0.14, 0] },
    steer: [1, 1, 0, 0, -1, -1], maxSteer: 0.6, maxSpeed: 0.8,
    batteryWh: 150, idleW: 4, solarW: 16, lightsW: 2,
    trackWheels: [0, 1, 4, 5], tread: 'cleat', crew: false, build: buildSojournerModel,
    photo: {
      file: 'sojourner.jpg', credit: 'NASA / JPL', license: 'Public domain',
      url: 'https://commons.wikimedia.org/wiki/File:Sojourner_on_Mars_PIA01122.jpg', parts: [
        { kind: 'sway', poly: [[0.48, 0], [0.55, 0], [0.57, 0.42], [0.5, 0.42]], px: 0.535, py: 0.4, amp: 0.04, period: 3.5 },
        { kind: 'glint', poly: [[0.18, 0.48], [0.41, 0.27], [0.78, 0.45], [0.47, 0.61]], period: 4 },
        { kind: 'spin', cx: 0.235, cy: 0.82, rx: 0.055, ry: 0.085, speed: 0.9 },
        { kind: 'spin', cx: 0.41, cy: 0.885, rx: 0.06, ry: 0.08, speed: 0.9 },
        { kind: 'spin', cx: 0.83, cy: 0.74, rx: 0.05, ry: 0.085, speed: 0.9 },
      ],
    },
    real: { massKg: 11.5, lengthM: 0.65, speedKmh: 0.036, wheels: 6, power: 'Solar 16 W', distanceKm: 0.1 },
  },
  curiosity: {
    id: 'curiosity', world: 'mars', country: 'usa', year: 2012,
    wheels: MSL_WHEELS, wheelRadius: 0.25, wheelWidth: 0.4, axleY: MSL_AXLE, travel: 0.12, mass: 899,
    body: { half: [0.56, 0.26, 0.93], offset: [0, 0.26, 0] },
    top: { half: [0.4, 0.4, 0.3], offset: [0, 0.9, 0.6] },
    steer: [1, 1, 0, 0, -1, -1], maxSteer: 0.55, maxSpeed: 2.2,
    batteryWh: 2600, idleW: 180, solarW: 110, lightsW: 40,
    trackWheels: [0, 1, 4, 5], tread: 'chevron', crew: false, build: () => buildMslModel('curiosity'),
    photo: {
      file: 'curiosity.jpg', credit: 'NASA / JPL-Caltech / MSSS (Mont Mercou, sol 3070)', license: 'Public domain',
      url: 'https://commons.wikimedia.org/wiki/File:Curiosity_rover_selfie_at_Mont_Mercou_Sol_3070_(53677088587).jpg', parts: [
        { kind: 'sway', poly: [[0.3, 0.06], [0.49, 0.06], [0.49, 0.29], [0.3, 0.29]], px: 0.39, py: 0.5, amp: 0.035, period: 8 },
        { kind: 'spin', cx: 0.67, cy: 0.635, rx: 0.05, ry: 0.09, speed: 0.4 },
        { kind: 'glint', poly: [[0.5, 0.3], [0.7, 0.33], [0.68, 0.5], [0.48, 0.45]], period: 6 },
      ],
    },
    real: { massKg: 899, lengthM: 3.0, speedKmh: 0.14, wheels: 6, power: 'MMRTG 110 W' },
  },
  perseverance: {
    id: 'perseverance', world: 'mars', country: 'usa', year: 2021,
    wheels: MSL_WHEELS, wheelRadius: 0.2625, wheelWidth: 0.4, axleY: MSL_AXLE, travel: 0.12, mass: 1025,
    body: { half: [0.56, 0.26, 0.93], offset: [0, 0.26, 0] },
    top: { half: [0.4, 0.4, 0.3], offset: [0, 0.9, 0.6] },
    steer: [1, 1, 0, 0, -1, -1], maxSteer: 0.55, maxSpeed: 2.2,
    batteryWh: 2600, idleW: 180, solarW: 110, lightsW: 40,
    trackWheels: [0, 1, 4, 5], tread: 'grouser', crew: false, build: () => buildMslModel('perseverance'),
    photo: {
      file: 'perseverance.jpg', credit: 'NASA / JPL-Caltech / MSSS', license: 'Public domain',
      url: 'https://commons.wikimedia.org/wiki/File:Perseverance_Stuns_in_New_Selfie.png', parts: [
        { kind: 'spin', cx: 0.755, cy: 0.2, rx: 0.042, ry: 0.11, speed: 0.4 },
        { kind: 'spin', cx: 0.62, cy: 0.79, rx: 0.07, ry: 0.13, speed: 0.4 },
        { kind: 'glint', poly: [[0.44, 0.05], [0.68, 0.02], [0.69, 0.2], [0.45, 0.26]], period: 6 },
      ],
    },
    real: { massKg: 1025, lengthM: 3.0, speedKmh: 0.152, wheels: 6, power: 'MMRTG 110 W' },
  },
  zhurong: {
    id: 'zhurong', world: 'mars', country: 'china', year: 2021,
    wheels: ZHURONG_WHEELS, wheelRadius: ZHURONG_R, wheelWidth: 0.2, axleY: ZHURONG_AXLE, travel: 0.08, mass: 240,
    body: { half: [0.48, 0.21, 0.63], offset: [0, 0.21, 0] },
    top: { half: [0.3, 0.3, 0.3], offset: [0, 0.8, 0.4] },
    steer: [1, 1, 0, 0, -1, -1], maxSteer: 0.55, maxSpeed: 1.7,
    batteryWh: 1000, idleW: 60, solarW: 240, lightsW: 30,
    trackWheels: [0, 1, 4, 5], tread: 'chevron', crew: false, build: buildZhurongModel,
    photo: {
      file: 'zhurong.jpg', credit: 'CNSA (via China News Service)', license: 'CC BY 4.0',
      url: 'https://commons.wikimedia.org/wiki/File:Zhurong-with-lander-selfie-flat.jpg', parts: [
        { kind: 'sway', poly: [[0.08, 0.53], [0.39, 0.53], [0.39, 0.7], [0.1, 0.7]], px: 0.39, py: 0.6, amp: 0.035, period: 4 },
        { kind: 'sway', poly: [[0.61, 0.53], [0.99, 0.53], [0.99, 0.7], [0.61, 0.7]], px: 0.61, py: 0.6, amp: -0.035, period: 4 },
        { kind: 'sway', poly: [[0.4, 0.04], [0.6, 0.04], [0.6, 0.2], [0.4, 0.2]], px: 0.5, py: 0.33, amp: 0.05, period: 7 },
        { kind: 'glint', poly: [[0.1, 0.55], [0.39, 0.55], [0.39, 0.68], [0.12, 0.68]], period: 5 },
      ],
    },
    real: { massKg: 240, lengthM: 2.6, speedKmh: 0.2, wheels: 6, power: 'Solar', distanceKm: 1.9 },
  },
};

export const ROVER_ORDER: RoverId[] = ['lrv', 'lunokhod', 'yutu2', 'perseverance', 'curiosity', 'zhurong', 'sojourner'];

export function roversFor(world: WorldId): RoverSpec[] {
  return ROVER_ORDER.map((id) => ROVERS[id]).filter((r) => r.world === world);
}

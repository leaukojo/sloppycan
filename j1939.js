// ── J1939 Decoder ─────────────────────────────────────────────────────────────
// Self-contained module. All J1939 state and rendering lives here.
//
// INTEGRATION POINTS — the only changes required in the main files:
//
//   sloppycan.js  ingestFrame(), after isotpIngestFrame(frame):
//     if (window.j1939IngestFrame) j1939IngestFrame(frame);          // ← line A
//
//   sloppycan.js  clearFrames(), at end:
//     if (window.j1939Clear) j1939Clear();                            // ← line B
//
//   index.html  view-tabs div:
//     <button class="view-tab" id="vtab-j1939" onclick="switchViewTab('j1939')">J1939</button>
//
//   index.html  switchViewTab():
//     + j1939 cases (tab toggle + wrap show/hide)
//
// To REVERT: remove lines A and B, remove the tab button, remove the tab content
// div, remove <script src="j1939.js">. No other changes needed.

// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.j1939-stab {
  background:transparent; border:none; border-bottom:2px solid transparent;
  color:var(--text2); cursor:pointer; font-family:var(--sans); font-size:12px;
  font-weight:500; padding:8px 14px; transition:color .15s,border-color .15s;
}
.j1939-stab:hover { color:var(--text); }
.j1939-stab.active { color:var(--green); border-bottom-color:var(--green); }
.j1939-tbl { width:100%; border-collapse:collapse; font-size:11.5px; }
.j1939-tbl th {
  text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.07em;
  color:var(--text3); padding:5px 8px; border-bottom:1px solid var(--border);
  font-weight:500; font-family:var(--sans); white-space:nowrap;
}
.j1939-tbl td {
  padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top;
  color:var(--text2); font-family:var(--mono);
}
.j1939-tbl tr:last-child td { border-bottom:none; }
.j1939-tbl td.j-pgn  { color:var(--text); }
.j1939-tbl td.j-name { font-family:var(--sans); color:var(--text2); }
.j1939-tbl td.j-sa   { color:var(--blue); }
.j1939-tbl td.j-val  { color:var(--green); font-family:var(--mono); }
.j1939-tbl td.j-ts   { color:var(--text3); font-size:10px; white-space:nowrap; }
.j1939-tbl td.j-raw  { color:var(--text3); font-size:10px; letter-spacing:.04em; }
.j1939-fault-badge { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; }
.j1939-fault-badge.dm1 { background:var(--red-dim);  color:var(--red); }
.j1939-fault-badge.dm2 { background:var(--amber-dim); color:var(--amber); }
.j1939-empty { text-align:center; color:var(--text3); font-size:12px; padding:48px 0; font-family:var(--sans); }
.j1939-log-row { display:flex; gap:12px; align-items:baseline; padding:3px 0; border-bottom:1px solid var(--border); font-size:11px; }
.j1939-log-row:last-child { border-bottom:none; }
.j1939-tp-badge { display:inline-block; padding:0 4px; background:var(--purple-dim); color:var(--purple); border-radius:3px; font-size:9px; margin-left:4px; }
`;
  document.head.appendChild(s);
})();

// ── Source Address name table ─────────────────────────────────────────────────
const J1939_SA = {
  0x00:'Engine #1',       0x01:'Engine #2',       0x02:'Turbocharger',
  0x03:'Transmission #1', 0x04:'Transmission #2',
  0x0B:'Brakes',          0x0C:'Retarder, Exhaust',
  0x0F:'Instrument Cluster', 0x10:'Cruise Control', 0x11:'Fuel System',
  0x17:'Suspension',      0x18:'Intake/Exhaust',   0x1C:'Power Takeoff',
  0x21:'Axle, Steering',  0x22:'Axle, Drive #1',  0x23:'Axle, Drive #2',
  0x27:'Instrument Cluster #1', 0x29:'Cab Display',
  0x33:'Body Controller', 0x37:'Cab Controller',  0x38:'Cab Controller #2',
  0x3D:'Tachograph',      0x47:'Lighting Controls',
  0xFE:'Null',            0xFF:'Global/Broadcast',
};

// ── FMI descriptions ──────────────────────────────────────────────────────────
const J1939_FMI = {
  0:'Above normal range (severe)',   1:'Below normal range (severe)',
  2:'Data erratic / incorrect',      3:'Voltage above normal / shorted high',
  4:'Voltage below normal / shorted low', 5:'Current below normal / open circuit',
  6:'Current above normal / grounded', 7:'Mechanical not responding',
  8:'Abnormal frequency / pulse',    9:'Abnormal update rate',
  10:'Abnormal rate of change',      11:'Root cause not known',
  12:'Bad device or component',      13:'Out of calibration',
  14:'Special instructions',         15:'Above normal (least severe)',
  16:'Below normal (moderate)',       17:'Below normal (least severe)',
  18:'Received data in error',        19:'Received data out of range',
  31:'Condition exists',
};

// ── J1939 Function codes (for Address Claim NAME decode) ──────────────────────
const J1939_FUNCTION = {
  0:'Non-specific',           25:'Trailer Refrigeration',  128:'Engine',
  130:'Transmission',         136:'Axle, Steering',        137:'Axle, Drive',
  138:'Brakes',               142:'Cruise Control',        144:'Instrument Cluster',
  145:'Trip Recorder',        146:'Navigation',            149:'Electrical System',
  151:'Steering Controller',  162:'Cab Controller',        165:'Body Controller',
  171:'Off-Vehicle Gateway',  176:'Multiplex',             184:'Tachograph',
  190:'Lighting Controls',    204:'Safety Restraint',
};
const J1939_INDUSTRY = ['Global','Highway','Agriculture','Construction','Marine','Industrial'];

// ── PGN database ──────────────────────────────────────────────────────────────
// SPN descriptor fields:
//   spn  – SPN number
//   name – human label
//   b    – start byte (0-indexed)
//   n    – byte count (1–4); use 0 for bit-level SPNs
//   f    – scale factor (displayed = raw * f + o)
//   o    – offset
//   u    – unit string
//   dp   – decimal places
//   bit  – (bit-level) LSB position within byte b
//   bits – (bit-level) number of bits
//   map  – (bit-level) {raw → label}
const J1939_DB = {
  0xF004:{ name:'Electronic Engine Controller 1', abbr:'EEC1', spns:[
    { spn:91,  name:'Driver Demand Torque', b:1, n:1, f:1, o:-125, u:'%', dp:0 },
    { spn:92,  name:'Actual Engine Torque', b:2, n:1, f:1, o:-125, u:'%', dp:0 },
    { spn:190, name:'Engine Speed',         b:3, n:2, f:0.125, o:0, u:'rpm', dp:1 },
  ]},
  0xF005:{ name:'Electronic Transmission Controller 2', abbr:'ETC2', spns:[
    { spn:524, name:'Selected Gear', b:3, n:1, f:1, o:-125, u:'', dp:0 },
    { spn:523, name:'Current Gear',  b:4, n:1, f:1, o:-125, u:'', dp:0 },
  ]},
  0xFEF1:{ name:'Cruise Control / Vehicle Speed', abbr:'CCVS1', spns:[
    { spn:84,  name:'Vehicle Speed',       b:1, n:2, f:1/256, o:0, u:'km/h', dp:1 },
    { spn:86,  name:'CC Set Speed',        b:4, n:1, f:1,     o:0, u:'km/h', dp:0 },
    { spn:595, name:'CC Active',           b:3, n:0, bit:0, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:597, name:'Brake Switch',        b:3, n:0, bit:2, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:598, name:'Clutch Switch',       b:3, n:0, bit:4, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
  ]},
  0xFEEE:{ name:'Engine Temperature 1', abbr:'ET1', spns:[
    { spn:110, name:'Coolant Temp', b:0, n:1, f:1,       o:-40,  u:'°C', dp:0 },
    { spn:174, name:'Fuel Temp',    b:1, n:1, f:1,       o:-40,  u:'°C', dp:0 },
    { spn:175, name:'Oil Temp',     b:2, n:2, f:0.03125, o:-273, u:'°C', dp:1 },
  ]},
  0xFEEF:{ name:'Engine Fluid Level/Pressure 1', abbr:'EFL/P1', spns:[
    { spn:94,  name:'Fuel Delivery Pressure', b:0, n:1, f:4,   o:0, u:'kPa', dp:0 },
    { spn:100, name:'Engine Oil Pressure',    b:3, n:1, f:4,   o:0, u:'kPa', dp:0 },
    { spn:111, name:'Coolant Level',          b:7, n:1, f:0.4, o:0, u:'%',   dp:0 },
  ]},
  0xFEF7:{ name:'Vehicle Electrical Power 1', abbr:'VEP1', spns:[
    { spn:167, name:'Alternator Voltage', b:4, n:2, f:0.05, o:0, u:'V', dp:2 },
    { spn:168, name:'Battery Voltage',    b:6, n:2, f:0.05, o:0, u:'V', dp:2 },
  ]},
  0xFEE5:{ name:'Engine Hours', abbr:'HOURS', spns:[
    { spn:247, name:'Total Engine Hours', b:0, n:4, f:0.05, o:0, u:'h', dp:1 },
  ]},
  0xFEE9:{ name:'Fuel Consumption', abbr:'FUEL', spns:[
    { spn:96, name:'Fuel Level', b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
  ]},
  0xFEF2:{ name:'Fuel Economy', abbr:'LFE', spns:[
    { spn:183, name:'Fuel Rate',     b:0, n:2, f:0.05,    o:0, u:'L/h',  dp:1 },
    { spn:184, name:'Fuel Economy',  b:2, n:2, f:1/512,   o:0, u:'km/L', dp:2 },
  ]},
  0xFEF5:{ name:'Ambient Conditions', abbr:'AMB', spns:[
    { spn:108, name:'Baro Pressure', b:0, n:2, f:0.0005,  o:0,   u:'kPa', dp:2 },
    { spn:171, name:'Ambient Temp',  b:4, n:2, f:0.03125, o:-273, u:'°C', dp:1 },
  ]},
  0xFEE0:{ name:'Vehicle Distance', abbr:'VD', spns:[
    { spn:244, name:'Total Distance', b:0, n:4, f:0.005, o:0, u:'km', dp:1 },
  ]},
  0xFEFC:{ name:'Dash Display', abbr:'DD', spns:[
    { spn:80, name:'Washer Fluid',  b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
    { spn:98, name:'Engine Oil Level', b:2, n:1, f:0.4, o:0, u:'%', dp:0 },
  ]},
  // DM1/DM2 handled separately; entries here provide name lookup only
  0xFECA:{ name:'Active DTCs (DM1)',           abbr:'DM1', spns:[] },
  0xFECB:{ name:'Previously Active DTCs (DM2)', abbr:'DM2', spns:[] },
  0xFECE:{ name:'Clear Active DTCs (DM3)',      abbr:'DM3', spns:[] },
  // Multi-packet messages (TP reassembly required)
  0xFEEC:{ name:'Vehicle Identification (VIN)', abbr:'VI',   spns:[] },
  0xFEDA:{ name:'Software Identification',      abbr:'SOFT', spns:[] },
};

// ── NMEA 2000 ─────────────────────────────────────────────────────────────────
// NMEA 2000 is J1939 at the wire level (29-bit IDs, PDU1/PDU2 PGN extraction,
// ISO Address Claim). What differs: a marine PGN dictionary, the Fast Packet
// multi-frame transport, and bit-packed fields that straddle byte boundaries —
// so it needs its own bit-offset field model (n2kDecodeField) rather than the
// whole-byte SPN model. The protocol-mode dropdown in the J1939 tab swaps which
// dictionary + transport is active; J1939 behaviour is untouched in 'j1939' mode.
const RAD2DEG = 180 / Math.PI;
const N2K_ANG = 0.0001 * RAD2DEG; // 0.0001 rad/bit → degrees

// Marine device-class names (NAME bits 49–55), for NMEA-mode Address Claim.
const NMEA_DEVICE_CLASS = {
  0:'Reserved', 10:'System Tools', 20:'Safety', 25:'Inter/Intranetwork Device',
  30:'Electrical Distribution', 35:'Electrical Generation', 40:'Steering and Control',
  50:'Propulsion', 60:'Navigation', 70:'Communication',
  75:'Sensor Communication Interface', 80:'Instrumentation/General',
  85:'External Environment', 90:'Internal Environment', 100:'Deck + Cargo + Fishing',
  120:'Display', 125:'Entertainment',
};

// Common temperature-source enum, shared by 130311/130312/130316.
const N2K_TEMP_SRC = {
  0:'Sea', 1:'Outside', 2:'Inside', 3:'Engine Room', 4:'Main Cabin', 5:'Live Well',
  6:'Bait Well', 7:'Refrigeration', 8:'Heating System', 9:'Dew Point',
  10:'Apparent Wind Chill', 11:'Theoretical Wind Chill', 12:'Heat Index', 13:'Freezer',
  14:'Exhaust Gas',
};
const N2K_DIR_REF = { 0:'True', 1:'Magnetic', 2:'Error', 3:'N/A' };

// PGN dictionary, keyed by (decimal) PGN. Field def:
//   { name, bo (bit offset, = byteIndex*8 for byte-aligned), bl (bit length),
//     signed, scale, offset, unit, dp, map, str, date, time }
// fp:true marks a Fast-Packet (multi-frame) PGN. SID/reserved bytes are omitted.
const NMEA2K_DB = {
  // ── System / ISO ──
  59904:{ name:'ISO Request', abbr:'59904', fp:false, fields:[
    { name:'Requested PGN', bo:0, bl:24 } ]},
  60928:{ name:'ISO Address Claim', abbr:'60928', fp:false, fields:[] }, // see Address Claim tab
  126208:{ name:'NMEA Group Function', abbr:'126208', fp:false, fields:[
    { name:'Function', bo:0, bl:8, map:{0:'Request',1:'Command',2:'Acknowledge',3:'Read Fields',4:'Read Reply',5:'Write Fields',6:'Write Reply'} },
    { name:'PGN', bo:8, bl:24 } ]},
  126464:{ name:'PGN List (Transmit/Receive)', abbr:'126464', fp:true, fields:[
    { name:'Function', bo:0, bl:8, map:{0:'Transmit PGNs',1:'Receive PGNs'} } ]},
  126992:{ name:'System Time', abbr:'126992', fp:false, fields:[
    { name:'Source', bo:8, bl:4, map:{0:'GPS',1:'GLONASS',2:'Radio Station',3:'Local Cesium',4:'Local Rubidium',5:'Local Crystal'} },
    { name:'Date', bo:16, bl:16, date:true },
    { name:'Time', bo:32, bl:32, scale:0.0001, time:true } ]},
  126993:{ name:'Heartbeat', abbr:'126993', fp:false, fields:[
    { name:'Tx Interval', bo:0, bl:16, scale:0.001, unit:'s', dp:2 },
    { name:'Sequence', bo:16, bl:8 } ]},
  126996:{ name:'Product Information', abbr:'126996', fp:true, fields:[
    { name:'N2K DB Ver', bo:0, bl:16, scale:0.001, dp:3 },
    { name:'Product Code', bo:16, bl:16 },
    { name:'Model ID', bo:32, bl:256, str:true },
    { name:'Software', bo:288, bl:256, str:true },
    { name:'Model Ver', bo:544, bl:256, str:true },
    { name:'Serial', bo:800, bl:256, str:true },
    { name:'Cert Level', bo:1056, bl:8 },
    { name:'Load Equiv', bo:1064, bl:8, scale:50, unit:'mA' } ]},
  126998:{ name:'Configuration Information', abbr:'126998', fp:true, fields:[] }, // variable strings

  // ── Vessel / navigation ──
  127250:{ name:'Vessel Heading', abbr:'127250', fp:false, fields:[
    { name:'Heading', bo:8, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Deviation', bo:24, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Variation', bo:40, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Reference', bo:56, bl:2, map:N2K_DIR_REF } ]},
  127251:{ name:'Rate of Turn', abbr:'127251', fp:false, fields:[
    { name:'Rate of Turn', bo:8, bl:32, signed:true, scale:(1/32)*1e-6*RAD2DEG, unit:'°/s', dp:2 } ]},
  127257:{ name:'Attitude', abbr:'127257', fp:false, fields:[
    { name:'Yaw', bo:8, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Pitch', bo:24, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Roll', bo:40, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 } ]},
  127258:{ name:'Magnetic Variation', abbr:'127258', fp:false, fields:[
    { name:'Source', bo:8, bl:4, map:{0:'Manual',1:'Auto Chart',2:'Auto Table',3:'Auto Calc',4:'WMM 2000',5:'WMM 2005',6:'WMM 2010',7:'WMM 2015',8:'WMM 2020'} },
    { name:'Variation', bo:32, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 } ]},
  128259:{ name:'Speed, Water Referenced', abbr:'128259', fp:false, fields:[
    { name:'Speed (Water)', bo:8, bl:16, scale:0.01, unit:'m/s', dp:2 },
    { name:'Speed (Ground)', bo:24, bl:16, scale:0.01, unit:'m/s', dp:2 },
    { name:'Sensor Type', bo:40, bl:8, map:{0:'Paddle Wheel',1:'Pitot Tube',2:'Doppler',3:'Correlation',4:'Electromagnetic'} } ]},
  128267:{ name:'Water Depth', abbr:'128267', fp:false, fields:[
    { name:'Depth', bo:8, bl:32, scale:0.01, unit:'m', dp:2 },
    { name:'Offset', bo:40, bl:16, signed:true, scale:0.001, unit:'m', dp:2 },
    { name:'Range', bo:56, bl:8, scale:10, unit:'m' } ]},
  128275:{ name:'Distance Log', abbr:'128275', fp:true, fields:[
    { name:'Date', bo:0, bl:16, date:true },
    { name:'Time', bo:16, bl:32, scale:0.0001, time:true },
    { name:'Total Log', bo:48, bl:32, scale:1, unit:'m' },
    { name:'Trip Log', bo:80, bl:32, scale:1, unit:'m' } ]},
  129025:{ name:'Position, Rapid Update', abbr:'129025', fp:false, fields:[
    { name:'Latitude', bo:0, bl:32, signed:true, scale:1e-7, unit:'°', dp:6 },
    { name:'Longitude', bo:32, bl:32, signed:true, scale:1e-7, unit:'°', dp:6 } ]},
  129026:{ name:'COG & SOG, Rapid Update', abbr:'129026', fp:false, fields:[
    { name:'COG Ref', bo:8, bl:2, map:N2K_DIR_REF },
    { name:'COG', bo:16, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'SOG', bo:32, bl:16, scale:0.01, unit:'m/s', dp:2 } ]},
  129029:{ name:'GNSS Position Data', abbr:'129029', fp:true, fields:[
    { name:'Date', bo:8, bl:16, date:true },
    { name:'Time', bo:24, bl:32, scale:0.0001, time:true },
    { name:'Latitude', bo:56, bl:64, signed:true, scale:1e-16, unit:'°', dp:6 },
    { name:'Longitude', bo:120, bl:64, signed:true, scale:1e-16, unit:'°', dp:6 },
    { name:'Altitude', bo:184, bl:64, signed:true, scale:1e-6, unit:'m', dp:1 },
    { name:'GNSS Type', bo:248, bl:4, map:{0:'GPS',1:'GLONASS',2:'GPS+GLONASS',3:'GPS+SBAS',4:'GPS+SBAS+GLONASS',5:'Chayka',6:'Integrated',7:'Surveyed',8:'Galileo'} },
    { name:'Fix Method', bo:252, bl:4, map:{0:'No GNSS',1:'GNSS Fix',2:'DGNSS',3:'Precise GNSS',4:'RTK Fixed',5:'RTK Float'} },
    { name:'Satellites', bo:264, bl:8 },
    { name:'HDOP', bo:272, bl:16, signed:true, scale:0.01, dp:1 },
    { name:'PDOP', bo:288, bl:16, signed:true, scale:0.01, dp:1 } ]},
  129033:{ name:'Time & Date', abbr:'129033', fp:false, fields:[
    { name:'Date', bo:0, bl:16, date:true },
    { name:'Time', bo:16, bl:32, scale:0.0001, time:true },
    { name:'Local Offset', bo:48, bl:16, signed:true, scale:1, unit:'min' } ]},
  129283:{ name:'Cross Track Error', abbr:'129283', fp:false, fields:[
    { name:'XTE Mode', bo:8, bl:4, map:{0:'Autonomous',1:'Differential',2:'Estimated',3:'Simulator',4:'Manual'} },
    { name:'XTE', bo:16, bl:32, signed:true, scale:0.01, unit:'m', dp:1 } ]},
  129284:{ name:'Navigation Data', abbr:'129284', fp:true, fields:[
    { name:'Distance to WP', bo:8, bl:32, scale:0.01, unit:'m', dp:0 },
    { name:'Bearing Orig→Dest', bo:96, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Bearing Pos→Dest', bo:112, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Dest Latitude', bo:192, bl:32, signed:true, scale:1e-7, unit:'°', dp:6 },
    { name:'Dest Longitude', bo:224, bl:32, signed:true, scale:1e-7, unit:'°', dp:6 },
    { name:'Closing Velocity', bo:256, bl:16, signed:true, scale:0.01, unit:'m/s', dp:2 } ]},
  129285:{ name:'Route/WP Information', abbr:'129285', fp:true, fields:[
    { name:'Start RPS#', bo:0, bl:16 },
    { name:'# Items', bo:16, bl:16 },
    { name:'Database ID', bo:32, bl:16 },
    { name:'Route ID', bo:48, bl:16 } ]},
  130306:{ name:'Wind Data', abbr:'130306', fp:false, fields:[
    { name:'Wind Speed', bo:8, bl:16, scale:0.01, unit:'m/s', dp:2 },
    { name:'Wind Angle', bo:24, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Reference', bo:40, bl:3, map:{0:'True (North)',1:'Magnetic',2:'Apparent',3:'True (boat ref)',4:'True (water ref)'} } ]},
  130310:{ name:'Environmental Parameters', abbr:'130310', fp:false, fields:[
    { name:'Water Temp', bo:8, bl:16, scale:0.01, offset:-273.15, unit:'°C', dp:1 },
    { name:'Air Temp', bo:24, bl:16, scale:0.01, offset:-273.15, unit:'°C', dp:1 },
    { name:'Pressure', bo:40, bl:16, scale:1, unit:'hPa', dp:0 } ]},
  130311:{ name:'Environmental Parameters', abbr:'130311', fp:false, fields:[
    { name:'Temp Source', bo:8, bl:6, map:N2K_TEMP_SRC },
    { name:'Humidity Source', bo:14, bl:2, map:{0:'Inside',1:'Outside'} },
    { name:'Temperature', bo:16, bl:16, scale:0.01, offset:-273.15, unit:'°C', dp:1 },
    { name:'Humidity', bo:32, bl:16, signed:true, scale:0.004, unit:'%', dp:1 },
    { name:'Pressure', bo:48, bl:16, scale:1, unit:'hPa', dp:0 } ]},
  130312:{ name:'Temperature', abbr:'130312', fp:false, fields:[
    { name:'Instance', bo:8, bl:8 },
    { name:'Source', bo:16, bl:8, map:N2K_TEMP_SRC },
    { name:'Temperature', bo:24, bl:16, scale:0.01, offset:-273.15, unit:'°C', dp:1 },
    { name:'Set Temp', bo:40, bl:16, scale:0.01, offset:-273.15, unit:'°C', dp:1 } ]},
  130316:{ name:'Temperature, Extended Range', abbr:'130316', fp:false, fields:[
    { name:'Instance', bo:8, bl:8 },
    { name:'Source', bo:16, bl:8, map:N2K_TEMP_SRC },
    { name:'Temperature', bo:24, bl:24, scale:0.001, offset:-273.15, unit:'°C', dp:2 },
    { name:'Set Temp', bo:48, bl:16, scale:0.1, offset:-273.15, unit:'°C', dp:1 } ]},

  // ── Engine / electrical ──
  127488:{ name:'Engine Parameters, Rapid Update', abbr:'127488', fp:false, fields:[
    { name:'Instance', bo:0, bl:8 },
    { name:'Engine Speed', bo:8, bl:16, scale:0.25, unit:'rpm', dp:0 },
    { name:'Boost Pressure', bo:24, bl:16, scale:0.1, unit:'kPa', dp:1 },
    { name:'Tilt/Trim', bo:40, bl:8, signed:true, unit:'%' } ]},
  127489:{ name:'Engine Parameters, Dynamic', abbr:'127489', fp:true, fields:[
    { name:'Instance', bo:0, bl:8 },
    { name:'Oil Pressure', bo:8, bl:16, scale:0.1, unit:'kPa', dp:1 },
    { name:'Oil Temp', bo:24, bl:16, scale:0.1, offset:-273.15, unit:'°C', dp:1 },
    { name:'Coolant Temp', bo:40, bl:16, scale:0.01, offset:-273.15, unit:'°C', dp:1 },
    { name:'Alternator', bo:56, bl:16, signed:true, scale:0.01, unit:'V', dp:2 },
    { name:'Fuel Rate', bo:72, bl:16, signed:true, scale:0.1, unit:'L/h', dp:1 },
    { name:'Engine Hours', bo:88, bl:32, scale:1/3600, unit:'h', dp:1 },
    { name:'Coolant Press', bo:120, bl:16, scale:0.1, unit:'kPa', dp:1 },
    { name:'Fuel Press', bo:136, bl:16, scale:1, unit:'kPa', dp:0 },
    { name:'Engine Load', bo:192, bl:8, signed:true, unit:'%' },
    { name:'Engine Torque', bo:200, bl:8, signed:true, unit:'%' } ]},
  127505:{ name:'Fluid Level', abbr:'127505', fp:false, fields:[
    { name:'Instance', bo:0, bl:4 },
    { name:'Type', bo:4, bl:4, map:{0:'Fuel',1:'Water',2:'Gray Water',3:'Live Well',4:'Oil',5:'Black Water',6:'Fuel (Gasoline)',15:'Error'} },
    { name:'Level', bo:8, bl:16, signed:true, scale:0.004, unit:'%', dp:1 },
    { name:'Capacity', bo:24, bl:32, scale:0.1, unit:'L', dp:1 } ]},
  127506:{ name:'DC Detailed Status', abbr:'127506', fp:true, fields:[
    { name:'Instance', bo:8, bl:8 },
    { name:'DC Type', bo:16, bl:8, map:{0:'Battery',1:'Alternator',2:'Convertor',3:'Solar Cell',4:'Wind Generator'} },
    { name:'State of Charge', bo:24, bl:8, unit:'%' },
    { name:'State of Health', bo:32, bl:8, unit:'%' },
    { name:'Time Remaining', bo:40, bl:16, scale:1, unit:'min' },
    { name:'Ripple Voltage', bo:56, bl:16, scale:0.001, unit:'V', dp:3 } ]},
  127508:{ name:'Battery Status', abbr:'127508', fp:false, fields:[
    { name:'Instance', bo:0, bl:8 },
    { name:'Voltage', bo:8, bl:16, signed:true, scale:0.01, unit:'V', dp:2 },
    { name:'Current', bo:24, bl:16, signed:true, scale:0.1, unit:'A', dp:1 },
    { name:'Temperature', bo:40, bl:16, scale:0.01, offset:-273.15, unit:'°C', dp:1 } ]},
  127513:{ name:'Battery Configuration', abbr:'127513', fp:true, fields:[
    { name:'Instance', bo:0, bl:8 },
    { name:'Battery Type', bo:8, bl:4, map:{0:'Flooded',1:'Gel',2:'AGM'} },
    { name:'Nominal Voltage', bo:16, bl:4, map:{0:'6V',1:'12V',2:'24V',3:'32V',4:'36V',5:'42V',6:'48V'} } ]},
};

// ── ISO 11783 (ISOBUS) ────────────────────────────────────────────────────────
// ISOBUS is the agricultural extension of J1939: identical 29-bit data link, plus
// an ag PGN set (tractor ECU / Task Controller / Virtual Terminal) and one new
// transport — the Extended Transport Protocol (ETP) for messages > 1785 bytes.
// Because the wire format is J1939, standard J1939 TP (0xEC/0xEB) stays active;
// only large transfers use ETP. ISOBUS mode spreads the full J1939_DB (tractors
// also speak standard engine/CCVS PGNs) and adds the ag PGNs below.

// Device-class names for NAME bits 49–55 under industry group 2 (agriculture),
// used by the ISOBUS-mode Address Claim tab.
const ISOBUS_DEVICE_CLASS = {
  0:'Non-specific', 1:'Tractor', 2:'Tillage', 3:'Secondary Tillage',
  4:'Planter/Seeder', 5:'Fertilizer', 6:'Sprayer', 7:'Harvester',
  8:'Root Harvester', 9:'Forage', 10:'Irrigation', 11:'Transport/Trailer',
  12:'Farmyard Operations', 13:'Powered Auxiliary', 14:'Special Crops',
  15:'Earthwork', 16:'Skidder', 17:'Sensor System', 19:'Timber Harvester',
  20:'Forwarder', 21:'Timber Loader', 22:'Timber Processing', 23:'Mower',
  24:'Tedder', 25:'Rake', 26:'Baler', 29:'Slurry/Manure Applicator',
  30:'Feeder/Mixer', 31:'Weeder',
};

// Task Controller process-data command (first nibble of byte 0, ISO 11783-10).
const ISOBUS_TC_CMD = {
  0:'Technical Capabilities', 1:'Device Descriptor', 2:'Request Value', 3:'Value',
  4:'Measurement Time Interval', 5:'Measurement Distance Interval',
  6:'Measurement Min Threshold', 7:'Measurement Max Threshold',
  8:'Measurement Change Threshold', 9:'Peer Control Assignment',
  10:'Set Value & Acknowledge', 13:'Process Data Acknowledge (PDACK)',
  15:'Task Controller Status',
};
// A few common Data Dictionary Identifiers (DDIs); fall back to hex otherwise.
const ISOBUS_DDI = {
  1:'Setpoint Volume/Area Rate', 2:'Actual Volume/Area Rate',
  5:'Setpoint Mass/Area Rate', 6:'Actual Mass/Area Rate',
  7:'Setpoint Count/Area Rate', 8:'Actual Count/Area Rate',
  74:'Actual Work State', 116:'Total Area', 117:'Effective Total Distance',
  118:'Ineffective Total Distance', 141:'Total Fuel Consumption',
  271:'Actual Application Rate', 290:'Yield', 359:'Loaded Weight',
};
// Virtual Terminal message function byte (ISO 11783-6) — labelled, not rendered.
const ISOBUS_VT_FN = {
  0:'Soft Key Activation', 1:'Button Activation', 2:'Pointing Event',
  3:'Select Input Object', 4:'ESC', 5:'Change Numeric Value',
  6:'Change Active Mask', 7:'Change Soft Key Mask', 8:'Change String Value',
  9:'Change Background Colour', 17:'Auxiliary Assignment',
  18:'Auxiliary Input Status', 0x11:'Object Pool Transfer',
  0x12:'End of Object Pool', 0xFE:'VT Status', 0xFF:'Working Set Maintenance',
};

// TC process-data is a packed {cmd(4b), element(12b), DDI(16b), value(32b)} record
// that neither the SPN nor the bit-field model decode cleanly, so it gets a custom
// decoder. j1939DecodePGN dispatches entry.decode(data) → [{name,display,valid}].
function isoTcDecode(data) {
  if (data.length < 8) return [];
  const cmd     = data[0] & 0x0F;
  const element = ((data[0] >> 4) & 0x0F) | (data[1] << 4); // 12-bit
  const ddi     = data[2] | (data[3] << 8);
  const value   = (data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24)) | 0; // signed 32-bit
  return [
    { name:'Command', display: ISOBUS_TC_CMD[cmd] ?? `Cmd ${cmd}`, valid:true },
    { name:'Element', display: String(element), valid:true },
    { name:'DDI', display: `0x${j1939H(ddi,4)}${ISOBUS_DDI[ddi] ? ' — ' + ISOBUS_DDI[ddi] : ''}`, valid:true },
    { name:'Value', display: String(value), valid:true },
  ];
}
function isoVtDecode(data) {
  if (!data.length) return [];
  const fn = data[0];
  return [{ name:'VT Function', display: ISOBUS_VT_FN[fn] ?? `0x${j1939H(fn)}`, valid:true }];
}

// ISOBUS = all J1939 PGNs (tractors speak standard engine/CCVS too) + the ag set.
const ISOBUS_DB = {
  ...J1939_DB,
  0xFE48:{ name:'Wheel-Based Speed & Distance', abbr:'WBSD', spns:[
    { name:'Wheel Speed',    b:0, n:2, f:0.001, o:0, u:'m/s', dp:3 },
    { name:'Wheel Distance', b:2, n:4, f:0.001, o:0, u:'m',   dp:0 },
    { name:'Direction', b:7, n:0, bit:6, bits:2, map:{0:'Reverse',1:'Forward',2:'Error',3:'N/A'} },
  ]},
  0xFE49:{ name:'Ground-Based Speed & Distance', abbr:'GBSD', spns:[
    { name:'Ground Speed',    b:0, n:2, f:0.001, o:0, u:'m/s', dp:3 },
    { name:'Ground Distance', b:2, n:4, f:0.001, o:0, u:'m',   dp:0 },
    { name:'Direction', b:7, n:0, bit:6, bits:2, map:{0:'Reverse',1:'Forward',2:'Error',3:'N/A'} },
  ]},
  0xFE45:{ name:'Rear PTO Drive', abbr:'RPTO', spns:[
    { name:'Rear PTO Speed',    b:0, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { name:'Rear PTO Setpoint', b:2, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { name:'Rear PTO Engaged', b:4, n:0, bit:0, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
  ]},
  0xFE46:{ name:'Front PTO Drive', abbr:'FPTO', spns:[
    { name:'Front PTO Speed',    b:0, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { name:'Front PTO Setpoint', b:2, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { name:'Front PTO Engaged', b:4, n:0, bit:0, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
  ]},
  0xFE43:{ name:'Rear Hitch Position & State', abbr:'RHPS', spns:[
    { name:'Rear Hitch Position', b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
    { name:'Rear Hitch In-Work', b:1, n:0, bit:0, bits:2, map:{0:'Out of Work',1:'In Work',2:'Error',3:'N/A'} },
  ]},
  0xFE44:{ name:'Front Hitch Position & State', abbr:'FHPS', spns:[
    { name:'Front Hitch Position', b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
    { name:'Front Hitch In-Work', b:1, n:0, bit:0, bits:2, map:{0:'Out of Work',1:'In Work',2:'Error',3:'N/A'} },
  ]},
  0xFEE8:{ name:'Vehicle Direction/Speed', abbr:'VDS', spns:[
    { name:'Compass Direction', b:0, n:2, f:1/128, o:0,     u:'°',    dp:1 },
    { name:'Pitch',             b:2, n:2, f:1/128, o:-200,  u:'°',    dp:1 },
    { name:'Altitude',          b:4, n:2, f:0.125, o:-2500, u:'m',    dp:1 },
    { name:'Speed',             b:6, n:2, f:1/256, o:0,     u:'km/h', dp:1 },
  ]},
  0xE000:{ name:'Task Controller / Process Data', abbr:'PD', decode: isoTcDecode },
  0xE600:{ name:'VT → ECU', abbr:'VT→ECU', decode: isoVtDecode },
  0xE700:{ name:'ECU → VT', abbr:'ECU→VT', decode: isoVtDecode },
  0xEA00:{ name:'Request PGN', abbr:'RQST', fields:[ { name:'Requested PGN', bo:0, bl:24 } ]},
  0xFED8:{ name:'Commanded Address', abbr:'CA', fields:[ { name:'New Address', bo:64, bl:8 } ]},
  // Auxiliary valve block — labelled (decode is application-specific / DDL-driven).
  0xFE2F:{ name:'Auxiliary Valve 0 Estimated Flow', abbr:'AUX0', spns:[] },
  0xFE2E:{ name:'Auxiliary Valve 1 Estimated Flow', abbr:'AUX1', spns:[] },
  0xFE24:{ name:'Auxiliary Valve Command',          abbr:'AUXC', spns:[] },
};

// Returns the dictionary for the active protocol mode (J1939 stays unchanged).
function j1939ActiveDb() {
  if (j1939ProtoMode === 'nmea2000') return NMEA2K_DB;
  if (j1939ProtoMode === 'iso11783') return ISOBUS_DB;
  return J1939_DB;
}

// ── NMEA 2000 bit-field decode ────────────────────────────────────────────────
// Little-endian. Supports arbitrary bit offset/length (≤32 via bit extraction;
// >32 must be byte-aligned, computed as a float — exact integers aren't needed
// for display, e.g. 64-bit lat/lon × 1e-16). Returns the same {name,display,valid}
// shape as j1939DecodeSPN so the existing renderers work unchanged.
function n2kDecodeField(def, data) {
  const bo = def.bo, bl = def.bl;
  const byteStart = bo >> 3;
  const byteEnd   = (bo + bl - 1) >> 3;
  if (data.length <= byteEnd) return null;

  if (def.str) {
    let s = '';
    for (let i = byteStart; i <= byteEnd && i < data.length; i++) {
      const c = data[i];
      if (c === 0 || c === 0xFF || c === 0x40) break; // 0x40 = N2K string filler
      if (c >= 32 && c < 127) s += String.fromCharCode(c);
    }
    s = s.trim();
    return { name: def.name, display: s || '—', valid: !!s };
  }

  let raw, allOnes;
  if (bl <= 32) {
    let acc = 0;
    for (let i = byteStart; i <= byteEnd; i++) acc += data[i] * Math.pow(2, 8 * (i - byteStart));
    raw = Math.floor(acc / Math.pow(2, bo & 7)) % Math.pow(2, bl);
    allOnes = Math.pow(2, bl) - 1;
    if (def.signed && raw >= Math.pow(2, bl - 1)) raw -= Math.pow(2, bl);
  } else {
    const nb = bl >> 3; // byte-aligned for >32-bit fields
    raw = 0;
    for (let i = 0; i < nb; i++) raw += data[byteStart + i] * Math.pow(2, 8 * i);
    allOnes = Math.pow(2, bl) - 1;
    if (def.signed && (data[byteStart + nb - 1] & 0x80)) raw -= Math.pow(2, bl);
  }

  // not-available (all ones / max positive) and out-of-range (next value) sentinels
  if (!def.signed) {
    if (raw === allOnes)     return { name: def.name, display: 'N/A', valid: false };
    if (raw === allOnes - 1) return { name: def.name, display: '—',   valid: false };
  } else {
    const maxPos = Math.pow(2, bl - 1) - 1;
    if (raw === maxPos)     return { name: def.name, display: 'N/A', valid: false };
    if (raw === maxPos - 1) return { name: def.name, display: '—',   valid: false };
  }

  if (def.map) return { name: def.name, display: def.map[raw] ?? String(raw), valid: true };

  const val = raw * (def.scale ?? 1) + (def.offset ?? 0);
  if (def.date) {
    const d = new Date(val * 86400000);
    return { name: def.name, display: isNaN(d.getTime()) ? String(val) : d.toISOString().slice(0, 10), valid: true };
  }
  if (def.time) {
    const sec = ((val % 86400) + 86400) % 86400;
    const p2 = n => String(n).padStart(2, '0');
    return { name: def.name, display: `${p2(Math.floor(sec/3600))}:${p2(Math.floor((sec%3600)/60))}:${p2(Math.floor(sec%60))}`, valid: true };
  }
  return { name: def.name, display: val.toFixed(def.dp ?? 0) + (def.unit ? ' ' + def.unit : ''), valid: true };
}

// ── NMEA 2000 Fast Packet reassembly ──────────────────────────────────────────
// Multi-frame inline transport (not J1939 TP). First frame: data[0]&0x1F==0,
// data[1]=total length, data[2..7]=first 6 bytes. Subsequent frames: data[1..7]
// = next 7 bytes at offset 6+(frameCounter-1)*7. Keyed by (pgn,sa,seqCounter).
let n2kFastPacket = new Map(); // `${pgn}:${sa}:${seq}` → {total, bytes, received, ts}

function n2kFastPacketIngest(pgn, sa, da, data, ts) {
  if (data.length < 2) return;
  const seq = (data[0] >> 5) & 0x07;
  const frameCounter = data[0] & 0x1F;
  const key = `${pgn}:${sa}:${seq}`;

  if (frameCounter === 0) {
    const total = data[1];
    const bytes = new Uint8Array(total);
    let n = 0;
    for (let i = 2; i < 8 && i < data.length && n < total; i++) bytes[n++] = data[i];
    n2kFastPacket.set(key, { total, bytes, received: n, ts });
  } else {
    const sess = n2kFastPacket.get(key);
    if (!sess) return;
    const offset = 6 + (frameCounter - 1) * 7;
    for (let i = 1; i < 8 && i < data.length; i++) {
      const pos = offset + (i - 1);
      if (pos < sess.total) { sess.bytes[pos] = data[i]; sess.received++; }
    }
    sess.ts = ts;
    if (sess.received >= sess.total) {
      n2kFastPacket.delete(key);
      j1939DispatchPGN(pgn, sa, da, Array.from(sess.bytes), ts, true);
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let j1939PgnMap  = new Map(); // `${pgn}:${sa}` → {pgn, sa, data, ts, count, spnResults}
let j1939AddrMap = new Map(); // sa → {sa, fnName, industryName, mfrCode, ecuInst, ts}
let j1939DmMap   = new Map(); // sa → {dm1:[...dtcs], dm2:[...dtcs], dm1ts, dm2ts}
let j1939Log     = [];        // last J1939_LOG_MAX decoded frames
let j1939TpSessions = new Map(); // session key → TP session state
let j1939SubActive = 'pgn';   // active sub-tab
let j1939ProtoMode = 'j1939'; // 'j1939' | 'nmea2000' — set by the tab's mode dropdown
let j1939Dirty   = false;     // render needed
let j1939WasHidden = true;    // true while the J1939 tab is not visible
let j1939LastTick = 0;        // last time the visible tab was force-refreshed (relative timestamps)
const J1939_LOG_MAX = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────
function j1939H(v, w = 2) { return v.toString(16).toUpperCase().padStart(w, '0'); }
function j1939Hex(v, w = 2) { return '0x' + j1939H(v, w); }

function j1939SaLabel(sa) {
  if (j1939AddrMap.has(sa)) return j1939AddrMap.get(sa).fnName;
  return J1939_SA[sa] || `SA 0x${j1939H(sa)}`;
}

function j1939PgnLabel(pgn) {
  const e = j1939ActiveDb()[pgn];
  return e ? `${e.abbr} – ${e.name}` : `PGN ${j1939H(pgn, 4)}`;
}

function j1939RelTs(ts) {
  const s = (Date.now() - ts) / 1000;
  return s < 1 ? 'now' : s < 60 ? s.toFixed(1) + 's ago' : Math.round(s / 60) + 'm ago';
}

// ── ID Parsing ────────────────────────────────────────────────────────────────
// J1939 always uses 29-bit extended IDs.
// Layout: [28:26] Priority | [25] Reserved | [24] Data Page |
//         [23:16] PDU Format (PF) | [15:8] PDU Specific (PS) | [7:0] Source Address
// PDU1 (PF < 0xF0): PS = destination address; PGN does NOT include PS
// PDU2 (PF ≥ 0xF0): PS is part of PGN; message is broadcast
function j1939ParseId(id) {
  const priority = (id >> 26) & 0x7;
  const dp       = (id >> 24) & 0x1;
  const pf       = (id >> 16) & 0xFF;
  const ps       = (id >> 8)  & 0xFF;
  const sa       = id         & 0xFF;
  let pgn, da;
  if (pf < 0xF0) {
    pgn = (dp << 16) | (pf << 8);   // PDU1: destination address not part of PGN
    da  = ps;
  } else {
    pgn = (dp << 16) | (pf << 8) | ps; // PDU2: PS is part of PGN
    da  = 0xFF;
  }
  return { priority, dp, pf, pgn, da, sa };
}

// ── SPN Decode ────────────────────────────────────────────────────────────────
function j1939DecodeSPN(def, data) {
  if (def.n === 0) {
    // Bit-level SPN
    if (data.length <= def.b) return null;
    const raw = (data[def.b] >> def.bit) & ((1 << def.bits) - 1);
    const allOnes = (1 << def.bits) - 1;
    if (raw === allOnes) return { name: def.name, display: 'N/A', valid: false };
    return { name: def.name, display: def.map?.[raw] ?? String(raw), valid: true };
  }
  if (data.length < def.b + def.n) return null;
  let raw = 0;
  for (let i = 0; i < def.n; i++) raw |= (data[def.b + i] << (8 * i));
  raw = raw >>> 0; // treat as unsigned
  // 0xFF…FE = error indicator, 0xFF…FF = not available — skip both
  const maxRaw = (Math.pow(2, def.n * 8) - 1) >>> 0;
  if (raw >= maxRaw - 1) return { name: def.name, display: raw === maxRaw ? 'N/A' : 'Error', valid: false };
  const val = raw * def.f + def.o;
  const display = val.toFixed(def.dp ?? 1) + (def.u ? ' ' + def.u : '');
  return { name: def.name, display, valid: true };
}

function j1939DecodePGN(pgn, data) {
  const entry = j1939ActiveDb()[pgn];
  if (!entry) return [];
  if (entry.decode) return entry.decode(data);                                              // custom decoder (ISOBUS TC/VT)
  if (entry.fields) return entry.fields.map(d => n2kDecodeField(d, data)).filter(Boolean); // NMEA bit-field model
  if (!entry.spns || !entry.spns.length) return [];
  return entry.spns.map(d => j1939DecodeSPN(d, data)).filter(Boolean);
}

// ── DM1/DM2 Decode ────────────────────────────────────────────────────────────
// Each DTC is 4 bytes:
//   Byte 0:      SPN bits  7:0
//   Byte 1:      SPN bits 15:8
//   Byte 2[7:5]: SPN bits 18:16  |  Byte 2[4:0]: FMI
//   Byte 3[7]:   CM (conversion method)  |  Byte 3[6:0]: occurrence count
function j1939DecodeDTCs(data) {
  const dtcs = [];
  for (let i = 2; i + 3 < data.length; i += 4) {
    const spn = (data[i]) | (data[i+1] << 8) | ((data[i+2] >> 5) << 16);
    const fmi = data[i+2] & 0x1F;
    const oc  = data[i+3] & 0x7F;
    if (spn === 0 && fmi === 0) continue;
    dtcs.push({ spn, fmi, oc, fmiDesc: J1939_FMI[fmi] || `FMI ${fmi}` });
  }
  return dtcs;
}

// ── Address Claim (NAME) Decode ───────────────────────────────────────────────
// The NAME is a 64-bit value transmitted little-endian (byte 0 = LSB).
// Bit layout:
//   Bits  0-20: Identity Number   (21 bits)
//   Bits 21-31: Manufacturer Code (11 bits)
//   Bits 32-34: ECU Instance      ( 3 bits)
//   Bits 35-39: Function Instance ( 5 bits)
//   Bits 40-47: Function          ( 8 bits)
//   Bit     48: Reserved
//   Bits 49-52: Vehicle System    ( 4 bits)
//   Bits 53-56: Vehicle Sys Inst  ( 4 bits)
//   Bits 57-59: Industry Group    ( 3 bits)
//   Bit     60: Arbitrary Addr Cap( 1 bit)
function j1939DecodeName(data) {
  if (data.length < 8) return null;
  // Split into two 32-bit words (bits 0-31 and bits 32-63)
  const lo = (data[0] | (data[1]<<8) | (data[2]<<16) | (data[3]<<24)) >>> 0;
  const hi = (data[4] | (data[5]<<8) | (data[6]<<16) | (data[7]<<24)) >>> 0;
  const fn          = (hi >>> 8)  & 0xFF;
  const industryGrp = (hi >>> 25) & 0x07;
  const ecuInst     = hi          & 0x07;
  const mfrCode     = (lo >>> 21) & 0x7FF;
  const arbitrary   = (hi >>> 28) & 0x01;
  const devClass    = (hi >>> 17) & 0x7F; // NAME bits 49–55 (marine device class)
  return {
    fn, mfrCode, ecuInst, industryGrp, arbitrary, devClass,
    fnName:       J1939_FUNCTION[fn]     || `Function ${fn}`,
    industryName: J1939_INDUSTRY[industryGrp] || `Group ${industryGrp}`,
  };
}

// ── Transport Protocol (J1939-21 TP) ─────────────────────────────────────────
// Handles BAM (broadcast) and CMDT (connection-mode) multi-packet reassembly.
// TP.CM messages arrive on PGN 0xEC00 (PDU1, PF=0xEC, PS=destination)
// TP.DT messages arrive on PGN 0xEB00 (PDU1, PF=0xEB, PS=destination)
//
// BAM flow:  SA → 0xFF: TP.CM_BAM → SA → 0xFF: TP.DT × N
// CMDT flow: SA → DA:   TP.CM_RTS → DA → SA: TP.CM_CTS → SA → DA: TP.DT × N → DA → SA: EndAck

function j1939TpKey(sa, da) { return da === 0xFF ? `BAM:${sa}` : `${sa}:${da}`; }

function j1939TpIngestCM(parsed, data, ts) {
  if (data.length < 8) return;
  const ctrl = data[0];
  const { sa, da } = parsed;

  if (ctrl === 0x20) {
    // TP.CM_BAM: broadcast announce
    const totalBytes = data[1] | (data[2] << 8);
    const totalPkts  = data[3];
    const pgn        = data[5] | (data[6] << 8) | (data[7] << 16);
    j1939TpSessions.set(j1939TpKey(sa, 0xFF), {
      pgn, sa, da: 0xFF, totalBytes, totalPkts, rxCount: 0,
      data: new Uint8Array(totalBytes), ts,
    });
  } else if (ctrl === 0x10) {
    // TP.CM_RTS: connection-mode request to send
    const totalBytes = data[1] | (data[2] << 8);
    const totalPkts  = data[3];
    const pgn        = data[5] | (data[6] << 8) | (data[7] << 16);
    j1939TpSessions.set(j1939TpKey(sa, da), {
      pgn, sa, da, totalBytes, totalPkts, rxCount: 0,
      data: new Uint8Array(totalBytes), ts,
    });
  } else if (ctrl === 0xFF) {
    // TP.CM_Conn_Abort
    j1939TpSessions.delete(j1939TpKey(sa, da));
  }
}

function j1939TpIngestDT(parsed, data, ts) {
  if (data.length < 2) return;
  const { sa, da } = parsed;
  const key  = j1939TpKey(sa, da);
  const sess = j1939TpSessions.get(key);
  if (!sess) return;

  const seqNum = data[0]; // 1-based
  const offset = (seqNum - 1) * 7;
  for (let i = 1; i < 8 && i < data.length; i++) {
    const pos = offset + (i - 1);
    if (pos < sess.totalBytes) sess.data[pos] = data[i];
  }
  sess.rxCount++;

  if (sess.rxCount >= sess.totalPkts) {
    // Reassembly complete — deliver as a full PGN
    j1939TpSessions.delete(key);
    j1939DispatchPGN(sess.pgn, sess.sa, sess.da, Array.from(sess.data), ts, true);
  }
}

// ── ISO 11783 Extended Transport Protocol (ETP, ISO 11783-6) ──────────────────
// For messages > 1785 bytes (J1939 TP's cap). ETP.CM on PGN 0xC800, ETP.DT on
// 0xC700. The trap vs J1939 TP: data-packet sequence numbers are relative to the
// most recent DPO (Data Packet Offset), so byteOffset = (dpoOffset + seq − 1)*7.
const ETP_MAX_BYTES = 256 * 1024; // cap reassembly buffer; abort beyond it
let isoEtpSessions = new Map();   // `${sa}:${da}` → {pgn, sa, da, totalBytes, dpoOffset, data, ts}

function isoEtpKey(sa, da) { return `${sa}:${da}`; }

function isoEtpIngestCM(parsed, data, ts) {
  if (data.length < 8) return;
  const ctrl = data[0];
  const { sa, da } = parsed;
  const key = isoEtpKey(sa, da);
  if (ctrl === 0x14) {
    // RTS: bytes 1–4 = total size (32-bit LE), bytes 5–7 = PGN
    const totalBytes = (data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24)) >>> 0;
    const pgn        = data[5] | (data[6] << 8) | (data[7] << 16);
    if (totalBytes === 0 || totalBytes > ETP_MAX_BYTES) { isoEtpSessions.delete(key); return; }
    isoEtpSessions.set(key, { pgn, sa, da, totalBytes, dpoOffset: 0, data: new Uint8Array(totalBytes), ts });
  } else if (ctrl === 0x16) {
    // DPO: byte 1 = num packets, bytes 2–4 = packet offset (3-byte LE)
    const sess = isoEtpSessions.get(key);
    if (!sess) return;
    sess.dpoOffset = data[2] | (data[3] << 8) | (data[4] << 16);
    sess.ts = ts;
  } else if (ctrl === 0xFF) {
    isoEtpSessions.delete(key); // Abort
  }
  // 0x15 CTS / 0x17 EOMA are receiver-side acks — ignored for passive reassembly.
}

function isoEtpIngestDT(parsed, data, ts) {
  if (data.length < 2) return;
  const { sa, da } = parsed;
  const key  = isoEtpKey(sa, da);
  const sess = isoEtpSessions.get(key);
  if (!sess) return;
  const seq = data[0]; // 1-based, relative to the current DPO offset
  const byteOffset = (sess.dpoOffset + seq - 1) * 7;
  let last = -1;
  for (let i = 1; i < 8 && i < data.length; i++) {
    const pos = byteOffset + (i - 1);
    if (pos < sess.totalBytes) { sess.data[pos] = data[i]; last = pos; }
  }
  sess.ts = ts;
  if (last >= sess.totalBytes - 1) { // final byte written — reassembly complete
    isoEtpSessions.delete(key);
    j1939DispatchPGN(sess.pgn, sess.sa, sess.da, Array.from(sess.data), ts, 'etp');
  }
}

// ── PGN Dispatch ──────────────────────────────────────────────────────────────
function j1939DispatchPGN(pgn, sa, da, data, ts, fromTP) {
  const pgnKey = `${pgn}:${sa}`;

  // Handle DM1/DM2
  if (pgn === 0xFECA || pgn === 0xFECB) {
    const dtcs = j1939DecodeDTCs(data);
    const entry = j1939DmMap.get(sa) || {};
    if (pgn === 0xFECA) { entry.dm1 = dtcs; entry.dm1ts = ts; }
    else                { entry.dm2 = dtcs; entry.dm2ts = ts; }
    j1939DmMap.set(sa, entry);
  }

  // Decode SPNs
  const spnResults = j1939DecodePGN(pgn, data);

  // Update live PGN table
  const existing = j1939PgnMap.get(pgnKey);
  j1939PgnMap.set(pgnKey, {
    pgn, sa, da, data, ts, fromTP,
    count: (existing?.count ?? 0) + 1,
    spnResults,
  });

  // Append to frame log (cap at J1939_LOG_MAX)
  j1939Log.push({ pgn, sa, da, data, ts, fromTP, spnResults });
  if (j1939Log.length > J1939_LOG_MAX) j1939Log.shift();

  j1939Dirty = true;
}

// ── Main Frame Ingest Hook ────────────────────────────────────────────────────
function j1939IngestFrame(frame) {
  if (!frame.isExt) return; // J1939 always uses 29-bit extended IDs
  const parsed = j1939ParseId(frame.id);
  const { pgn, sa, da } = parsed;
  const data = frame.data;
  const ts   = Date.now();

  // Address Claim: PGN 0xEE00 (PDU2: PF=0xEE, SA broadcasts its NAME) — shared by both modes
  if (pgn === 0xEE00) {
    const name = j1939DecodeName(data);
    if (name) {
      j1939AddrMap.set(sa, { sa, ts, ...name });
      j1939Dirty = true;
    }
    return;
  }

  // NMEA 2000: Fast Packet for multi-frame PGNs (no J1939 TP), else dispatch immediately.
  if (j1939ProtoMode === 'nmea2000') {
    const entry = NMEA2K_DB[pgn];
    if (entry && entry.fp) { n2kFastPacketIngest(pgn, sa, da, data, ts); return; }
    j1939DispatchPGN(pgn, sa, da, data, ts, false);
    return;
  }

  // ISO 11783: large messages use ETP (0xC800 CM / 0xC700 DT). Standard J1939 TP
  // (0xEC/0xEB, handled below) stays active — only ETP frames return early here.
  if (j1939ProtoMode === 'iso11783') {
    const pf = (frame.id >> 16) & 0xFF;
    if (pf === 0xC8) { isoEtpIngestCM(parsed, data, ts); return; }
    if (pf === 0xC7) { isoEtpIngestDT(parsed, data, ts); return; }
  }

  // J1939 TP.CM: PGN 0xEC00 (PF=0xEC < 0xF0 → PDU1, PS=destination)
  if ((frame.id >> 16 & 0xFF) === 0xEC) { j1939TpIngestCM(parsed, data, ts); return; }

  // J1939 TP.DT: PGN 0xEB00
  if ((frame.id >> 16 & 0xFF) === 0xEB) { j1939TpIngestDT(parsed, data, ts); return; }

  // Regular PGN
  j1939DispatchPGN(pgn, sa, da, data, ts, false);
}

// ── Protocol mode (J1939 ↔ NMEA 2000) ─────────────────────────────────────────
// Swaps the active dictionary + transport. Clears the live tables so entries
// re-decode under the new dictionary. Persisted per-workspace as `j1939Proto`.
function j1939SetProto(mode) {
  mode = (mode === 'nmea2000' || mode === 'iso11783') ? mode : 'j1939';
  j1939ProtoMode = mode;
  const sel = document.getElementById('j1939ProtoSel');
  if (sel && sel.value !== mode) sel.value = mode;
  const lkN = document.getElementById('nmea2000LearnLink');
  if (lkN) lkN.style.display = (mode === 'nmea2000') ? '' : 'none';
  const lkI = document.getElementById('iso11783LearnLink');
  if (lkI) lkI.style.display = (mode === 'iso11783') ? '' : 'none';
  // NMEA 2000 has no DM1/DM2 — hide the Faults sub-tab in NMEA mode (ISOBUS keeps it).
  const dmBtn = document.getElementById('j1939stab-dm');
  if (dmBtn) dmBtn.style.display = (mode === 'nmea2000') ? 'none' : '';
  if (mode === 'nmea2000' && j1939SubActive === 'dm') j1939SubTab('pgn');
  // Fresh rebuild — entries cache decoded values from the prior dictionary.
  j1939PgnMap.clear(); j1939Log = []; j1939DmMap.clear();
  n2kFastPacket.clear(); isoEtpSessions.clear(); j1939TpSessions.clear();
  j1939Dirty = true;
  j1939Render();
}
window.j1939SetProto = j1939SetProto;
window.j1939GetProto = () => j1939ProtoMode;
window.j1939Apply    = (m) => j1939SetProto(m || window._j1939ProtoPending || 'j1939');

// ── Clear Hook ────────────────────────────────────────────────────────────────
function j1939Clear() {
  j1939PgnMap.clear();
  j1939AddrMap.clear();
  j1939DmMap.clear();
  j1939Log = [];
  j1939TpSessions.clear();
  j1939Dirty = true;
}

// ── Sub-tab Switching ─────────────────────────────────────────────────────────
function j1939SubTab(name) {
  j1939SubActive = name;
  ['pgn','log','dm','addr'].forEach(n => {
    const btn = document.getElementById('j1939stab-' + n);
    btn.classList.toggle('active', n === name);
    btn.setAttribute('aria-selected', n === name ? 'true' : 'false');
    document.getElementById('j1939-' + n).style.display = n === name ? '' : 'none';
  });
  j1939Dirty = true; // only the active sub-tab is rendered; force the newly-shown one
  j1939Render();
}

// ── Render ────────────────────────────────────────────────────────────────────
function j1939Render() {
  if (document.getElementById('j1939Wrap')?.style.display === 'none') { j1939WasHidden = true; return; }
  if (j1939WasHidden) { j1939WasHidden = false; j1939Dirty = true; } // tab just became visible — refresh
  if (!j1939Dirty) return;
  j1939Dirty = false;

  const badge = document.getElementById('j1939Badge');
  if (badge) badge.textContent = `${j1939PgnMap.size} PGN${j1939PgnMap.size !== 1 ? 's' : ''} · ${j1939AddrMap.size} addr`;

  switch (j1939SubActive) {
    case 'pgn':  j1939RenderPGN();  break;
    case 'log':  j1939RenderLog();  break;
    case 'dm':   j1939RenderDM();   break;
    case 'addr': j1939RenderAddr(); break;
  }
}

function j1939SpnHtml(results) {
  if (!results || !results.length) return '<span style="color:var(--text3)">—</span>';
  return results.filter(r => r.valid).map(r =>
    `<span style="color:var(--text2);font-family:var(--sans);font-size:10px">${r.name}</span> `+
    `<span style="color:var(--green)">${r.display}</span>`
  ).join('<br>');
}

function j1939BytesHtml(data, max = 32) {
  const arr = Array.from(data);
  const shown = arr.slice(0, max).map(b => j1939H(b)).join(' ');
  return arr.length > max ? `${shown} … <span style="color:var(--text3)">(${arr.length} bytes)</span>` : shown;
}

// PGN Monitor — one row per PGN per SA, most recent values
function j1939RenderPGN() {
  const el = document.getElementById('j1939-pgn');
  if (!j1939PgnMap.size) { el.innerHTML = '<div class="j1939-empty">No J1939 frames received yet.<br>J1939 uses 29-bit extended CAN IDs.</div>'; return; }

  const rows = [...j1939PgnMap.values()].sort((a,b) => a.pgn - b.pgn || a.sa - b.sa);
  const db = j1939ActiveDb();
  el.innerHTML = `<table class="j1939-tbl">
  <thead><tr>
    <th>PGN</th><th>Name</th><th>SA (Source)</th><th>Values</th>
    <th>Frames</th><th>Last seen</th><th>Raw data</th>
  </tr></thead>
  <tbody>` +
  rows.map(e => {
    const entry = db[e.pgn];
    const pgnStr = j1939H(e.pgn, 4);
    const name = entry ? `<b>${entry.abbr}</b> <span style="color:var(--text3)">${entry.name}</span>` : `PGN ${pgnStr}`;
    const tpBadge = e.fromTP ? `<span class="j1939-tp-badge">${e.fromTP === 'etp' ? 'ETP' : (j1939ProtoMode === 'nmea2000' ? 'FP' : 'TP')}</span>` : '';
    return `<tr>
      <td class="j-pgn">${pgnStr}${tpBadge}</td>
      <td class="j-name">${name}</td>
      <td class="j-sa" style="white-space:nowrap">0x${j1939H(e.sa)}<br><span style="color:var(--text3);font-family:var(--sans);font-size:10px">${j1939SaLabel(e.sa)}</span></td>
      <td>${j1939SpnHtml(e.spnResults)}</td>
      <td class="j-ts">${e.count}</td>
      <td class="j-ts">${j1939RelTs(e.ts)}</td>
      <td class="j-raw">${j1939BytesHtml(e.data)}</td>
    </tr>`;
  }).join('') +
  '</tbody></table>';
}

// Frame Log — last J1939_LOG_MAX decoded frames, newest first
function j1939RenderLog() {
  const el = document.getElementById('j1939-log');
  if (!j1939Log.length) { el.innerHTML = '<div class="j1939-empty">No J1939 frames in log yet.</div>'; return; }

  el.innerHTML = `<table class="j1939-tbl">
  <thead><tr>
    <th>Time</th><th>PGN</th><th>SA → DA</th><th>Values / Raw</th>
  </tr></thead>
  <tbody>` +
  [...j1939Log].reverse().map(e => {
    const entry = j1939ActiveDb()[e.pgn];
    const pgnLabel = entry ? `<b>${entry.abbr}</b>` : j1939H(e.pgn,4);
    const tpBadge  = e.fromTP ? `<span class="j1939-tp-badge">${e.fromTP === 'etp' ? 'ETP' : (j1939ProtoMode === 'nmea2000' ? 'FP' : 'TP')}</span>` : '';
    const daStr    = e.da === 0xFF ? 'FF (bcast)' : j1939H(e.da);
    const vals     = e.spnResults?.filter(r=>r.valid).map(r=>`${r.name}: ${r.display}`).join(' · ') || j1939BytesHtml(e.data);
    return `<tr>
      <td class="j-ts">${j1939RelTs(e.ts)}</td>
      <td class="j-pgn">${pgnLabel}${tpBadge}</td>
      <td class="j-sa" style="white-space:nowrap">0x${j1939H(e.sa)} → 0x${daStr}</td>
      <td style="font-size:10.5px;color:var(--text2);font-family:var(--mono)">${vals}</td>
    </tr>`;
  }).join('') +
  '</tbody></table>';
}

// Faults — DM1 (active) and DM2 (previously active) per SA
function j1939RenderDM() {
  const el = document.getElementById('j1939-dm');
  if (!j1939DmMap.size) { el.innerHTML = '<div class="j1939-empty">No DM1/DM2 messages received yet.<br>DM1 = active faults, DM2 = previously active.</div>'; return; }

  let html = '';
  for (const [sa, entry] of [...j1939DmMap.entries()].sort((a,b) => a[0]-b[0])) {
    const saName = j1939SaLabel(sa);
    html += `<div style="margin-bottom:20px">
    <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px;font-family:var(--sans)">
      SA 0x${j1939H(sa)} — ${saName}
    </div>`;
    for (const [type, dtcs, ts] of [['dm1',entry.dm1,entry.dm1ts],['dm2',entry.dm2,entry.dm2ts]]) {
      if (!dtcs) continue;
      html += `<div style="margin-bottom:8px">
      <span class="j1939-fault-badge ${type}">${type.toUpperCase()}</span>
      <span style="font-size:10px;color:var(--text3);margin-left:6px;font-family:var(--sans)">${ts ? j1939RelTs(ts) : ''} — ${dtcs.length} fault${dtcs.length!==1?'s':''}</span>`;
      if (!dtcs.length) {
        html += `<span style="font-size:11px;color:var(--green);margin-left:10px;font-family:var(--sans)">No active faults</span>`;
      } else {
        html += `<table class="j1939-tbl" style="margin-top:4px">
        <thead><tr><th>SPN</th><th>FMI</th><th>Description</th><th>Count</th></tr></thead>
        <tbody>` + dtcs.map(d => {
          // Deep-link the SPN to dtc.html (reconstruct the 4-byte DM record). Revert: drop the <a> wrap.
          const rec = [d.spn & 0xFF, (d.spn >> 8) & 0xFF, (((d.spn >> 16) & 0x7) << 5) | (d.fmi & 0x1F), d.oc & 0x7F];
          const href = `dtc.html?bytes=${rec.map(x => x.toString(16).toUpperCase().padStart(2,'0')).join('+')}&fmt=j1939`;
          return `<tr>
          <td class="j-pgn"><a href="${href}" target="_blank" style="color:inherit;text-decoration:none" title="Decode in DTC decoder">${d.spn} ↗</a></td>
          <td class="j-ts">${d.fmi}</td>
          <td class="j-name">${d.fmiDesc}</td>
          <td class="j-ts">${d.oc}</td>
        </tr>`; }).join('') + '</tbody></table>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

// Address Claim — SA → device identity table
function j1939RenderAddr() {
  const el = document.getElementById('j1939-addr');
  if (!j1939AddrMap.size) { el.innerHTML = '<div class="j1939-empty">No Address Claim (PGN 0xEE00) messages received.<br>Devices broadcast their identity when joining the bus.</div>'; return; }

  el.innerHTML = `<table class="j1939-tbl">
  <thead><tr>
    <th>SA</th><th>Function</th><th>Industry</th><th>ECU Instance</th>
    <th>Mfr Code</th><th>Arb. Addr</th><th>Last seen</th>
  </tr></thead>
  <tbody>` +
  [...j1939AddrMap.values()].sort((a,b)=>a.sa-b.sa).map(e => `<tr>
    <td class="j-pgn">0x${j1939H(e.sa)}</td>
    <td class="j-name">${j1939ProtoMode === 'nmea2000'
      ? `${NMEA_DEVICE_CLASS[e.devClass] || ('Class ' + e.devClass)} <span style="color:var(--text3)">/ Fn ${e.fn}</span>`
      : j1939ProtoMode === 'iso11783'
      ? `${ISOBUS_DEVICE_CLASS[e.devClass] || ('Class ' + e.devClass)} <span style="color:var(--text3)">/ Fn ${e.fn}</span>`
      : e.fnName}</td>
    <td class="j-name">${e.industryName}</td>
    <td class="j-ts">${e.ecuInst}</td>
    <td class="j-ts">0x${j1939H(e.mfrCode,3)}</td>
    <td class="j-ts">${e.arbitrary ? 'Yes' : 'No'}</td>
    <td class="j-ts">${j1939RelTs(e.ts)}</td>
  </tr>`).join('') +
  '</tbody></table>';
}

// ── Demo (NMEA 2000) ──────────────────────────────────────────────────────────
// window.j1939DemoFrames() is called by sloppycan.js's demo loop; it returns an
// array of synthetic N2K frames for the current tick, EMPTY unless NMEA mode is
// active (so the J1939 tab/ID List stay clean otherwise). Includes a 127489
// Fast-Packet burst so reassembly is exercised.
let j1939DemoTickN = 0; // tick counter (FP burst every 5th)
let j1939DemoSeq   = 0; // rotating Fast-Packet sequence counter
function j1939BuildId(pgn, sa, prio = 6) { // inverse of j1939ParseId (PDU2 broadcast)
  const dp = (pgn >> 16) & 1, pf = (pgn >> 8) & 0xFF, ps = pgn & 0xFF;
  return ((prio << 26) | (dp << 24) | (pf << 16) | (ps << 8) | sa) >>> 0;
}
function n2kFrame(pgn, sa, data) { return { id: j1939BuildId(pgn, sa), isExt: true, isRtr: false, dlc: data.length, data }; }
function n2kU16(v) { v = Math.round(v) & 0xFFFF; return [v & 0xFF, (v >> 8) & 0xFF]; }
function n2kI16(v) { v = Math.round(v); if (v < 0) v += 0x10000; v &= 0xFFFF; return [v & 0xFF, (v >> 8) & 0xFF]; }
function n2kU32(v) { v = Math.round(v) >>> 0; return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }
function n2kI32(v) { v = Math.round(v); if (v < 0) v += 0x100000000; v = v >>> 0; return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }

function j1939DemoFrames() {
  if (j1939ProtoMode === 'iso11783') return isoDemoFrames();
  if (j1939ProtoMode !== 'nmea2000') return [];
  const t = Date.now() / 1000;
  const osc = (lo, hi, p, ph = 0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / p + ph));
  const frames = [];
  // 127250 Vessel Heading (true) — single frame
  frames.push(n2kFrame(127250, 0x02, [0xFF, ...n2kU16(osc(0, 2*Math.PI, 30) / 0.0001), 0x7F, 0xFF, 0x7F, 0xFF, 0x00]));
  // 127488 Engine Rapid — speed + boost
  frames.push(n2kFrame(127488, 0x00, [0x00, ...n2kU16(osc(700, 3500, 11) / 0.25), ...n2kU16(120000 / 100), 0x00, 0xFF, 0xFF]));
  // 129025 Position Rapid Update (1e-7 deg)
  frames.push(n2kFrame(129025, 0x17, [...n2kI32((37.81 + 0.001 * Math.sin(t / 20)) / 1e-7), ...n2kI32((-122.45 + 0.001 * Math.cos(t / 20)) / 1e-7)]));
  // 130306 Wind Data (apparent)
  frames.push(n2kFrame(130306, 0x1A, [0xFF, ...n2kU16(osc(0, 15, 17) / 0.01), ...n2kU16(osc(0, 2*Math.PI, 23) / 0.0001), 0x02, 0xFF, 0xFF]));

  // 127489 Engine Dynamic (Fast Packet, 26-byte payload) every 5th tick
  if ((j1939DemoTickN++ % 5) === 0) {
    const payload = [
      0x00,                                 // instance
      ...n2kU16(350000 / 100),              // oil pressure (kPa = 350)
      ...n2kU16((90 + 273.15) / 0.1),       // oil temp 90 °C
      ...n2kU16((osc(82, 96, 60) + 273.15) / 0.01), // coolant temp
      ...n2kI16(1390),                      // alternator 13.90 V
      ...n2kI16(osc(5, 40, 13) / 0.1),      // fuel rate
      ...n2kU32(1234 * 3600),               // engine hours
      ...n2kU16(450000 / 100),              // coolant pressure
      ...n2kU16(300000 / 1000),             // fuel pressure
      0xFF,                                 // reserved
      0x00, 0x00, 0x00, 0x00,              // discrete status 1 & 2
      Math.round(osc(20, 85, 9)) & 0xFF,   // engine load %
      0x32,                                 // engine torque %
    ]; // 26 bytes
    const seq = (j1939DemoSeq++ & 0x07), total = payload.length;
    let idx = 0;
    const f0 = [(seq << 5) | 0, total];
    for (let i = 0; i < 6; i++) f0.push(idx < total ? payload[idx++] : 0xFF);
    frames.push(n2kFrame(127489, 0x00, f0));
    for (let fc = 1; idx < total; fc++) {
      const fr = [(seq << 5) | fc];
      for (let i = 0; i < 7; i++) fr.push(idx < total ? payload[idx++] : 0xFF);
      frames.push(n2kFrame(127489, 0x00, fr));
    }
  }
  return frames;
}
// ── Demo (ISO 11783 / ISOBUS) ─────────────────────────────────────────────────
// Synthetic TECU speed/PTO/hitch + a Task-Controller value, periodic ag address
// claims, and (every 80th tick) a >1785-byte ETP object-pool transfer to the VT
// so ETP reassembly + the DPO offset path are exercised. Empty unless ISOBUS mode.
let isoDemoTick = 0;
function isoEtpDemoFrames(sa, da, targetPgn, payload) {
  const frames = [];
  const total = payload.length;
  const pgn3 = [targetPgn & 0xFF, (targetPgn >> 8) & 0xFF, (targetPgn >> 16) & 0xFF];
  const totalPkts = Math.ceil(total / 7);
  frames.push(n2kFrame(0xC800, sa, [0x14, ...n2kU32(total), ...pgn3])); // RTS
  const emitWindow = (dpoOffset, nPkts) => {
    // DPO: ctrl 0x16, num packets, 3-byte packet offset, PGN — then the DT packets.
    frames.push(n2kFrame(0xC800, sa, [0x16, nPkts & 0xFF, dpoOffset & 0xFF, (dpoOffset >> 8) & 0xFF, (dpoOffset >> 16) & 0xFF, ...pgn3]));
    for (let p = 1; p <= nPkts; p++) {
      const off = (dpoOffset + p - 1) * 7;
      const fr = [p];
      for (let i = 0; i < 7; i++) fr.push(off + i < total ? payload[off + i] : 0xFF);
      frames.push(n2kFrame(0xC700, sa, fr));
    }
  };
  const win1 = Math.min(totalPkts, 200); // two DPO windows to exercise the offset path
  emitWindow(0, win1);
  if (totalPkts > win1) emitWindow(win1, totalPkts - win1);
  return frames;
}
function isoDemoFrames() {
  const t = Date.now() / 1000;
  const osc = (lo, hi, p, ph = 0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / p + ph));
  const frames = [];
  const tick = isoDemoTick++;

  // Tractor ECU (SA 0xF0): wheel speed/distance, rear PTO, rear hitch, direction/speed.
  frames.push(n2kFrame(0xFE48, 0xF0, [...n2kU16(osc(0, 8, 17) / 0.001), ...n2kU32(Math.round((t % 1000) * 1000)), 0xFF, 0x40]));
  frames.push(n2kFrame(0xFE45, 0xF0, [...n2kU16(osc(0, 1000, 13) / 0.125), ...n2kU16(540 / 0.125), 0x01, 0xFF, 0xFF, 0xFF]));
  frames.push(n2kFrame(0xFE43, 0xF0, [Math.round(osc(0, 100, 23) / 0.4) & 0xFF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
  frames.push(n2kFrame(0xFEE8, 0xF0, [...n2kU16(osc(0, 360, 60) * 128), ...n2kU16((osc(-10, 10, 31) + 200) * 128), ...n2kU16((120 + 2500) / 0.125), ...n2kU16(osc(0, 30, 17) * 256)]));

  // Task Controller (SA 0x80): a "Value" (cmd 3) for application-rate DDI 271.
  const ddi = 271, element = 5, cmd = 3, val = Math.round(osc(0, 5000, 8));
  frames.push(n2kFrame(0xE000, 0x80, [((element & 0x0F) << 4) | cmd, (element >> 4) & 0xFF, ddi & 0xFF, (ddi >> 8) & 0xFF, val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF]));

  // Address claims (ag NAMEs, every 30th tick): a tractor + a sprayer implement.
  if (tick % 30 === 0) {
    const name = (id, mfr, fn, devClass, indGrp) =>
      [...n2kU32((id | (mfr << 21)) >>> 0), ...n2kU32(((fn << 8) | (devClass << 17) | (indGrp << 25) | (1 << 28)) >>> 0)];
    frames.push(n2kFrame(0xEE00, 0xF0, name(0x12345, 100, 130, 1, 2))); // Tractor
    frames.push(n2kFrame(0xEE00, 0x80, name(0x23456, 137, 6,   6, 2))); // Sprayer
  }

  // ETP transfer (every 80th tick): a >1785-byte object pool to the VT (0xE700).
  if (tick % 80 === 1) {
    const total = 1792, payload = new Array(total);
    for (let i = 0; i < total; i++) payload[i] = 0x20 + (i % 0x5F);
    frames.push(...isoEtpDemoFrames(0x80, 0xF0, 0xE700, payload));
  }
  return frames;
}

window.j1939DemoFrames = j1939DemoFrames;

// ── Render loop ───────────────────────────────────────────────────────────────
(function loop() {
  // Force a refresh ~1×/s so relative "Last seen" timestamps keep ticking with no new traffic
  const now = Date.now();
  if (now - j1939LastTick >= 1000) { j1939Dirty = true; j1939LastTick = now; }
  // Drop stale Fast-Packet / ETP sessions so a lost middle frame can't wedge a slot.
  for (const [k, s] of n2kFastPacket) if (now - s.ts > 1000) n2kFastPacket.delete(k);
  for (const [k, s] of isoEtpSessions) if (now - s.ts > 2000) isoEtpSessions.delete(k);
  j1939Render();
  requestAnimationFrame(loop);
})();

// Apply a proto mode stashed by applySettings() before this deferred module loaded.
if (window._j1939ProtoPending) j1939SetProto(window._j1939ProtoPending);

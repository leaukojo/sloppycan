// ── J1939 reference tables + pure decoders (shared) ─────────────────────────────
// The ONE copy of the J1939 dictionary: source addresses, FMIs, NAME functions and industry
// groups, the PGN/SPN database, and the DOM-free decoders that read them - plus the NMEA 2000 and
// ISOBUS dictionaries (NMEA2K_DB / ISOBUS_DB) the J1939 tab's other two modes use. No DOM, no state, no
// window.* - so the app (index.html, before j1939.js), explainers/dtc.html and
// explainers/j1939-explainer.html all load this same file instead of carrying copies, which is how
// a wrong entry used to get fixed in one place and survive in another.
//
// A classic script: its top-level const/function names join the page-wide lexical scope, so
// j1939.js / isobus.js / the self-tests use them directly. Never redeclare one elsewhere.

// ── Source Address name table ─────────────────────────────────────────────────
// Preferred addresses, taken from the ISOBUS Data Dictionary's SourceAddress table
// (isobus.net), which is the same list J1939-81 assigns. Most of what used to be here was
// off by several places - 0x21/0x22/0x23 were labelled as the axles, where the real axle
// addresses are 0x08/0x09/0x0A and 0x21/0x22/0x23 are the body controller, auxiliary valve
// control and hitch control - so a decoded frame named the wrong ECU. Corrected against that
// table when isobus.js needed 0xF0.
const J1939_SA = {
  0x00:'Engine #1',       0x01:'Engine #2',       0x02:'Turbocharger',
  0x03:'Transmission #1', 0x04:'Transmission #2', 0x05:'Shift Console - Primary',
  0x07:'Power TakeOff (Main or Rear)',
  0x08:'Axle - Steering', 0x09:'Axle - Drive #1', 0x0A:'Axle - Drive #2',
  0x0B:'Brakes - System Controller', 0x0C:'Brakes - Steer Axle',
  0x0F:'Retarder - Engine', 0x10:'Retarder - Driveline', 0x11:'Cruise Control',
  0x17:'Instrument Cluster #1', 0x18:'Trip Recorder', 0x1C:'Vehicle Navigation',
  0x21:'Body Controller',
  0x22:'Auxiliary Valve Control', 0x23:'Hitch Control', 0x26:'Virtual Terminal (in cab)',
  0x27:'Management Computer #1', 0x29:'Retarder, Exhaust, Engine #1',
  0x33:'Tire Pressure Controller', 0x37:'Lighting - Operator Controls',
  0x38:'Rear Axle Steering Controller #1',
  0x3D:'Exhaust Emission Controller', 0x47:'Chassis Controller #1',
  // 0xF9 is J1939-81's Off-Board Diagnostic-Service Tool #1 - the address the request client
  // in j1939.js claims, because a tool asking a vehicle for a PGN is exactly what that address is for.
  0xF9:'Off-Board Diagnostic-Service Tool #1',
  // 0xF0 is the ISO 11783-4 Tractor ECU, the gateway between the tractor and implement buses -
  // and the source isobus.js publishes the tractor's ISO 11783-7 messages from.
  0xF0:'Tractor ECU',
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
  16:'Above normal (moderate)',       17:'Below normal (least severe)',
  18:'Below normal (moderate)',       19:'Received network data in error',
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
const J1939_INDUSTRY = ['Global','On-Highway','Agriculture/Forestry','Construction','Marine','Industrial/Stationary'];

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
//   onesValid – (bit-level) all-ones is a real state (TSC1's modes), not "not available"
const J1939_DB = {
  // EEC2 carries SPN 92, the engine load the carlito contract's `engine_load` borrows, and
  // isobus.js publishes it here. Byte 3, 1 %/bit, no offset - a percent LOAD, not a percent
  // torque, which is why it does not carry EEC1's -125 offset.
  0xF003:{ name:'Electronic Engine Controller 2', abbr:'EEC2', spns:[
    { spn:91,  name:'Accelerator Pedal Position 1',   b:1, n:1, f:0.4, o:0, u:'%', dp:0 },
    { spn:92,  name:'Percent Load At Current Speed',  b:2, n:1, f:1,   o:0, u:'%', dp:0 },
    { spn:974, name:'Remote Accelerator Pedal Position', b:3, n:1, f:0.4, o:0, u:'%', dp:0 },
  ]},
  // Bytes 2 and 3 are SPN 512 / 513 per J1939-71, not 91 / 92: those two are EEC2's accelerator
  // pedal and percent load, one PGN below. The names were right, the SPN numbers were not.
  0xF004:{ name:'Electronic Engine Controller 1', abbr:'EEC1', spns:[
    { spn:512, name:"Driver's Demand Engine - Percent Torque", b:1, n:1, f:1, o:-125, u:'%', dp:0 },
    { spn:513, name:'Actual Engine - Percent Torque',          b:2, n:1, f:1, o:-125, u:'%', dp:0 },
    { spn:190, name:'Engine Speed',         b:3, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { spn:1483, name:'Source Address of Controlling Device for Engine Control', b:5, n:1, f:1, o:0, u:'', dp:0 },
  ]},
  // The differential locks, one 2-bit state each. isobus.js publishes the tractor's rear
  // differential (SPN 569) here; the rest decode for anything else on the bus that sends them.
  0xF006:{ name:'Electronic Axle Controller 1', abbr:'EAC1', spns:[
    { spn:927, name:'Location', b:0, n:1, f:1, o:0, u:'', dp:0 },
    { spn:567, name:'Diff Lock - Front Axle 1', b:1, n:0, bit:0, bits:2, map:{0:'Unlocked',1:'Locked',2:'Error',3:'N/A'} },
    { spn:568, name:'Diff Lock - Front Axle 2', b:1, n:0, bit:2, bits:2, map:{0:'Unlocked',1:'Locked',2:'Error',3:'N/A'} },
    { spn:569, name:'Diff Lock - Rear Axle 1',  b:1, n:0, bit:4, bits:2, map:{0:'Unlocked',1:'Locked',2:'Error',3:'N/A'} },
    { spn:570, name:'Diff Lock - Rear Axle 2',  b:1, n:0, bit:6, bits:2, map:{0:'Unlocked',1:'Locked',2:'Error',3:'N/A'} },
    { spn:564, name:'Diff Lock - Central',       b:2, n:0, bit:0, bits:2, map:{0:'Unlocked',1:'Locked',2:'Error',3:'N/A'} },
    { spn:565, name:'Diff Lock - Central Front', b:2, n:0, bit:2, bits:2, map:{0:'Unlocked',1:'Locked',2:'Error',3:'N/A'} },
    { spn:566, name:'Diff Lock - Central Rear',  b:2, n:0, bit:4, bits:2, map:{0:'Unlocked',1:'Locked',2:'Error',3:'N/A'} },
  ]},
  0xFDDF:{ name:'Front Wheel Drive Status', abbr:'FWD', spns:[
    { spn:2612, name:'Front Wheel Drive Actuator Status', b:0, n:0, bit:0, bits:2, map:{0:'Not engaged',1:'Engaged',2:'Error',3:'N/A'} },
  ]},
  // ERC1 carries SPN 520, the retarder torque the carlito contract's `retarder_state` borrows,
  // and j1939-flavor.js publishes it here. Byte 2, 1 %/bit, -125 offset: a retarder is a BRAKE, so
  // the standard's operating range is -125..0 % and the game's 0..100 magnitude is negated on its
  // way onto the wire. The mode names in byte 1 are TABLE SPN899_A, a figure in J1939-71 rather
  // than text - so only 0000b, which the surrounding text does state, is named here.
  0xF000:{ name:'Electronic Retarder Controller 1', abbr:'ERC1', spns:[
    { spn:900,  name:'Retarder Torque Mode', b:0, n:0, bit:0, bits:4, map:{0:'No request',15:'N/A'} },
    { spn:571,  name:'Retarder Enable - Brake Assist Switch', b:0, n:0, bit:4, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:572,  name:'Retarder Enable - Shift Assist Switch', b:0, n:0, bit:6, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:520,  name:'Actual Retarder - Percent Torque',   b:1, n:1, f:1, o:-125, u:'%', dp:0 },
    { spn:1085, name:'Intended Retarder Percent Torque',   b:2, n:1, f:1, o:-125, u:'%', dp:0 },
    { spn:1082, name:'Engine Coolant Load Increase',        b:3, n:0, bit:0, bits:2, map:{0:'No increase',1:'Increase possible',3:'N/A'} },
    { spn:1667, name:'Retarder Requesting Brake Light',     b:3, n:0, bit:2, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:1480, name:'Source Address of Controlling Device for Retarder Control', b:4, n:1, f:1, o:0, u:'', dp:0 },
    { spn:1715, name:'Drivers Demand Retarder - Percent Torque', b:5, n:1, f:1,   o:-125, u:'%', dp:0 },
    { spn:1716, name:'Retarder Selection, non-engine',           b:6, n:1, f:0.4, o:0,    u:'%', dp:0 },
    { spn:1717, name:'Actual Maximum Available Retarder - Percent Torque', b:7, n:1, f:1, o:-125, u:'%', dp:0 },
  ]},
  // Byte 1 is SPN 524 and byte 4 SPN 523 per J1939-71 (bytes 2-3 are SPN 526 Actual Gear Ratio).
  0xF005:{ name:'Electronic Transmission Controller 2', abbr:'ETC2', spns:[
    { spn:524, name:'Selected Gear', b:0, n:1, f:1, o:-125, u:'', dp:0 },
    { spn:526, name:'Actual Gear Ratio', b:1, n:2, f:0.001, o:0, u:'', dp:3 },
    { spn:523, name:'Current Gear',  b:3, n:1, f:1, o:-125, u:'', dp:0 },
  ]},
  // The driver-demand groups j1939-flavor.js decodes into Carlito's accel / brake / steer / gear
  // (and the demo sends from the RAMN Control Panel). Positions off J1939-71.
  0xF001:{ name:'Electronic Brake Controller 1', abbr:'EBC1', spns:[
    { spn:521, name:'Brake Pedal Position', b:1, n:1, f:0.4, o:0, u:'%', dp:0 },
    // 3.7, decoded into Carlito's tcs_off. J1939-71: "disables the automatic traction control
    // function allowing the wheels to spin. 00 off 01 on 10 Error 11 Not available".
    { spn:1238, name:'Traction Control Override Switch', b:2, n:0, bit:6, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
  ]},
  // VDC2 is also what j1939-flavor.js packs off the truck's ESC sensors (yaw, accelerations); the
  // steering wheel angle stays the driver demand's. Positions and scales off J1939-71 pp. 220-221, 308.
  0xF009:{ name:'Vehicle Dynamic Stability Control 2', abbr:'VDC2', spns:[
    { spn:1807, name:'Steering Wheel Angle', b:0, n:2, f:1/1024, o:-31.374, u:'rad', dp:3 },
    { spn:1811, name:'Steering Wheel Turn Counter', b:2, n:0, bit:0, bits:6 },
    { spn:1812, name:'Steering Wheel Angle Sensor Type', b:2, n:0, bit:6, bits:2, map:{0:'Relative',1:'Absolute',2:'Reserved',3:'N/A'} },
    { spn:1808, name:'Yaw Rate', b:3, n:2, f:1/8192, o:-3.92, u:'rad/s', dp:3 },
    { spn:1809, name:'Lateral Acceleration', b:5, n:2, f:1/2048, o:-15.687, u:'m/s²', dp:2 },
    { spn:1810, name:'Longitudinal Acceleration', b:7, n:1, f:0.1, o:-12.5, u:'m/s²', dp:1 },
  ]},
  // VDC1: the stability unit's status, packed by j1939-flavor.js. Positions and states off
  // J1939-71 pp. 222-223, 322 (SPN 5624 is not in that edition's group).
  0xFE4F:{ name:'Vehicle Dynamic Stability Control 1', abbr:'VDC1', spns:[
    { spn:1813, name:'VDC Information Signal', b:0, n:0, bit:0, bits:2, map:{0:'Off',1:'On',2:'Reserved',3:'N/A'} },
    { spn:1814, name:'VDC Fully Operational', b:0, n:0, bit:2, bits:2, map:{0:'Not fully operational',1:'Fully operational',2:'Reserved',3:'N/A'} },
    { spn:1815, name:'VDC brake light request', b:0, n:0, bit:4, bits:2, map:{0:'Off',1:'On',2:'Reserved',3:'N/A'} },
    { spn:1816, name:'ROP Engine Control active', b:1, n:0, bit:0, bits:2, map:{0:'Passive',1:'Active',2:'Reserved',3:'N/A'} },
    { spn:1818, name:'ROP Brake Control active',  b:1, n:0, bit:2, bits:2, map:{0:'Passive',1:'Active',2:'Reserved',3:'N/A'} },
    { spn:1817, name:'YC Engine Control active',  b:1, n:0, bit:4, bits:2, map:{0:'Passive',1:'Active',2:'Reserved',3:'N/A'} },
    { spn:1819, name:'YC Brake Control active',   b:1, n:0, bit:6, bits:2, map:{0:'Passive',1:'Active',2:'Reserved',3:'N/A'} },
  ]},
  // PDU1 (PF 0x01): keyed by PGN, the destination is not part of it.
  0x0100:{ name:'Transmission Control 1', abbr:'TC1', spns:[
    { spn:525, name:'Requested Gear', b:2, n:1, f:1, o:-125, u:'', dp:0 },
  ]},
  0xFEF1:{ name:'Cruise Control / Vehicle Speed', abbr:'CCVS1', spns:[
    { spn:70,  name:'Parking Brake Switch', b:0, n:0, bit:2, bits:2, map:{0:'Not set',1:'Set',2:'Error',3:'N/A'} },
    { spn:84,  name:'Vehicle Speed',       b:1, n:2, f:1/256, o:0, u:'km/h', dp:1 },
    { spn:86,  name:'CC Set Speed',        b:5, n:1, f:1,     o:0, u:'km/h', dp:0 },
    { spn:595, name:'CC Active',           b:3, n:0, bit:0, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:596, name:'CC Enable Switch',    b:3, n:0, bit:2, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:597, name:'Brake Switch',        b:3, n:0, bit:4, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:598, name:'Clutch Switch',       b:3, n:0, bit:6, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
  ]},
  // CCSS carries the CONFIGURED speed limits, not measured speed - SPN 74 is what a road-speed
  // governor is set to, and the game publishes it as the carlito contract's 'speed_limit'. The
  // PGN is sent ON REQUEST rather than periodically, so nothing here generates it; this entry
  // exists so a requested one decodes with its SPNs named.
  0xFEED:{ name:'Cruise Control/Vehicle Speed Setup', abbr:'CCSS', spns:[
    { spn:74, name:'Max Vehicle Speed Limit',  b:0, n:1, f:1, o:0, u:'km/h', dp:0 },
    { spn:87, name:'CC High Set Limit Speed',  b:1, n:1, f:1, o:0, u:'km/h', dp:0 },
    { spn:88, name:'CC Low Set Limit Speed',   b:2, n:1, f:1, o:0, u:'km/h', dp:0 },
  ]},
  0xFEEE:{ name:'Engine Temperature 1', abbr:'ET1', spns:[
    { spn:110, name:'Coolant Temp', b:0, n:1, f:1,       o:-40,  u:'°C', dp:0 },
    { spn:174, name:'Fuel Temp',    b:1, n:1, f:1,       o:-40,  u:'°C', dp:0 },
    { spn:175, name:'Oil Temp',     b:2, n:2, f:0.03125, o:-273, u:'°C', dp:1 },
  ]},
  0xFEEF:{ name:'Engine Fluid Level/Pressure 1', abbr:'EFL/P1', spns:[
    { spn:94,  name:'Fuel Delivery Pressure', b:0, n:1, f:4,   o:0, u:'kPa', dp:0 },
    { spn:98,  name:'Engine Oil Level',       b:2, n:1, f:0.4, o:0, u:'%',   dp:0 },
    { spn:100, name:'Engine Oil Pressure',    b:3, n:1, f:4,   o:0, u:'kPa', dp:0 },
    { spn:111, name:'Coolant Level',          b:7, n:1, f:0.4, o:0, u:'%',   dp:0 },
  ]},
  // Bytes 1 / 2 are SPN 114 / 115 (currents), so the voltages sit at 3-4 and 5-6 per J1939-71.
  0xFEF7:{ name:'Vehicle Electrical Power 1', abbr:'VEP1', spns:[
    { spn:167, name:'Alternator Voltage', b:2, n:2, f:0.05, o:0, u:'V', dp:2 },
    { spn:168, name:'Battery Voltage',    b:4, n:2, f:0.05, o:0, u:'V', dp:2 },
  ]},
  0xFEE5:{ name:'Engine Hours', abbr:'HOURS', spns:[
    { spn:247, name:'Total Engine Hours', b:0, n:4, f:0.05, o:0, u:'h', dp:1 },
  ]},
  // 65257 carries fuel USED, not fuel level - SPN 96 Fuel Level is Dash Display's (0xFEFC) byte 2.
  0xFEE9:{ name:'Fuel Consumption (Liquid)', abbr:'LFC', spns:[
    { spn:182, name:'Trip Fuel',       b:0, n:4, f:0.5, o:0, u:'L', dp:1 },
    { spn:250, name:'Total Fuel Used', b:4, n:4, f:0.5, o:0, u:'L', dp:1 },
  ]},
  0xFEF2:{ name:'Fuel Economy', abbr:'LFE', spns:[
    { spn:183, name:'Fuel Rate',     b:0, n:2, f:0.05,    o:0, u:'L/h',  dp:1 },
    { spn:184, name:'Fuel Economy',  b:2, n:2, f:1/512,   o:0, u:'km/L', dp:2 },
  ]},
  0xFEF5:{ name:'Ambient Conditions', abbr:'AMB', spns:[
    { spn:108, name:'Baro Pressure', b:0, n:1, f:0.5,     o:0,   u:'kPa', dp:1 },
    { spn:171, name:'Ambient Temp',  b:3, n:2, f:0.03125, o:-273, u:'°C', dp:1 },
  ]},
  // AIR1 is the truck's air-brake reservoirs, and the pair the carlito contract's `air_primary` /
  // `air_secondary` borrow (SPN 1087 / 1088). Every pressure in the group is 8 kPa/bit, 0 offset.
  0xFEAE:{ name:'Air Supply Pressure', abbr:'AIR1', spns:[
    { spn:46,   name:'Pneumatic Supply Pressure',              b:0, n:1, f:8, o:0, u:'kPa', dp:0 },
    { spn:1086, name:'Parking and/or Trailer Air Pressure',    b:1, n:1, f:8, o:0, u:'kPa', dp:0 },
    { spn:1087, name:'Service Brake Air Pressure Circuit #1',  b:2, n:1, f:8, o:0, u:'kPa', dp:0 },
    { spn:1088, name:'Service Brake Air Pressure Circuit #2',  b:3, n:1, f:8, o:0, u:'kPa', dp:0 },
    { spn:1089, name:'Auxiliary Equipment Supply Pressure',    b:4, n:1, f:8, o:0, u:'kPa', dp:0 },
    { spn:1090, name:'Air Suspension Supply Pressure',         b:5, n:1, f:8, o:0, u:'kPa', dp:0 },
  ]},
  // VW carries SPN 582, the axle weight the contract's `axle_load` borrows - but its transmission
  // repetition rate is ON REQUEST, so nothing generates it periodically; j1939.js's request server
  // answers a 59904 for it. SPN 928 Axle Location is what says WHICH axle a given VW is about,
  // which is why the group can be answered "with as many messages as necessary".
  0xFEEA:{ name:'Vehicle Weight', abbr:'VW', spns:[
    { spn:928, name:'Axle Location',  b:0, n:1, f:1,   o:0, u:'',   dp:0 },
    { spn:582, name:'Axle Weight',    b:1, n:2, f:0.5, o:0, u:'kg', dp:0 },
    { spn:180, name:'Trailer Weight', b:3, n:2, f:2,   o:0, u:'kg', dp:0 },
    { spn:181, name:'Cargo Weight',   b:5, n:2, f:2,   o:0, u:'kg', dp:0 },
  ]},
  0xFEE0:{ name:'Vehicle Distance', abbr:'VD', spns:[
    { spn:244, name:'Trip Distance',          b:0, n:4, f:0.125, o:0, u:'km', dp:1 },
    { spn:245, name:'Total Vehicle Distance', b:4, n:4, f:0.125, o:0, u:'km', dp:1 },
  ]},
  0xFEFC:{ name:'Dash Display', abbr:'DD', spns:[
    { spn:80, name:'Washer Fluid', b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
    { spn:96, name:'Fuel Level',   b:1, n:1, f:0.4, o:0, u:'%', dp:0 },
  ]},
  // ── More J1939-71 groups (layouts + resolutions read off the DEC2003 document) ──
  // PDU1 (PF 0x00): keyed by PGN, the destination is not part of it.
  0x0000:{ name:'Torque/Speed Control 1', abbr:'TSC1', spns:[
    { spn:695, name:'Override Control Mode', b:0, n:0, bit:0, bits:2, onesValid:true, map:{0:'Override disabled',1:'Speed control',2:'Torque control',3:'Speed/torque limit control'} },
    { spn:696, name:'Requested Speed Control Conditions', b:0, n:0, bit:2, bits:2, onesValid:true, map:{0:'Transient, disengaged',1:'Stability, disengaged',2:'Stability, engaged 1',3:'Stability, engaged 2'} },
    { spn:897, name:'Override Control Mode Priority', b:0, n:0, bit:4, bits:2, onesValid:true, map:{0:'Highest',1:'High',2:'Medium',3:'Low'} },
    { spn:898, name:'Requested Speed/Speed Limit',   b:1, n:2, f:0.125, o:0,    u:'rpm', dp:1 },
    { spn:518, name:'Requested Torque/Torque Limit', b:3, n:1, f:1,     o:-125, u:'%',   dp:0 },
  ]},
  0xF002:{ name:'Electronic Transmission Controller 1', abbr:'ETC1', spns:[
    { spn:560, name:'Driveline Engaged', b:0, n:0, bit:0, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
    { spn:573, name:'Torque Converter Lockup Engaged', b:0, n:0, bit:2, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
    { spn:574, name:'Shift In Process', b:0, n:0, bit:4, bits:2, map:{0:'No',1:'Yes',2:'Error',3:'N/A'} },
    { spn:191, name:'Output Shaft Speed',  b:1, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { spn:522, name:'Percent Clutch Slip', b:3, n:1, f:0.4,   o:0, u:'%',   dp:0 },
    { spn:161, name:'Input Shaft Speed',   b:5, n:2, f:0.125, o:0, u:'rpm', dp:1 },
  ]},
  0xFEBF:{ name:'Wheel Speed Information', abbr:'EBC2', spns:[
    { spn:904, name:'Front Axle Speed', b:0, n:2, f:1/256, o:0, u:'km/h', dp:1 },
    { spn:905, name:'Rel. Speed Front Left',   b:2, n:1, f:1/16, o:-7.8125, u:'km/h', dp:2 },
    { spn:906, name:'Rel. Speed Front Right',  b:3, n:1, f:1/16, o:-7.8125, u:'km/h', dp:2 },
    { spn:907, name:'Rel. Speed Rear 1 Left',  b:4, n:1, f:1/16, o:-7.8125, u:'km/h', dp:2 },
    { spn:908, name:'Rel. Speed Rear 1 Right', b:5, n:1, f:1/16, o:-7.8125, u:'km/h', dp:2 },
    { spn:909, name:'Rel. Speed Rear 2 Left',  b:6, n:1, f:1/16, o:-7.8125, u:'km/h', dp:2 },
    { spn:910, name:'Rel. Speed Rear 2 Right', b:7, n:1, f:1/16, o:-7.8125, u:'km/h', dp:2 },
  ]},
  0xFEF6:{ name:'Inlet/Exhaust Conditions 1', abbr:'IC1', spns:[
    { spn:81,  name:'Particulate Trap Inlet Pressure', b:0, n:1, f:0.5,  o:0,  u:'kPa', dp:1 },
    { spn:102, name:'Boost Pressure',                  b:1, n:1, f:2,    o:0,  u:'kPa', dp:0 },
    { spn:105, name:'Intake Manifold 1 Temp',          b:2, n:1, f:1,    o:-40, u:'°C', dp:0 },
    { spn:106, name:'Air Inlet Pressure',              b:3, n:1, f:2,    o:0,  u:'kPa', dp:0 },
    { spn:107, name:'Air Filter 1 Diff. Pressure',     b:4, n:1, f:0.05, o:0,  u:'kPa', dp:2 },
    { spn:173, name:'Exhaust Gas Temp',                b:5, n:2, f:0.03125, o:-273, u:'°C', dp:1 },
    { spn:112, name:'Coolant Filter Diff. Pressure',   b:7, n:1, f:0.5,  o:0,  u:'kPa', dp:1 },
  ]},
  0xFEC1:{ name:'High Resolution Vehicle Distance', abbr:'VDHR', spns:[
    { spn:917, name:'HR Total Vehicle Distance', b:0, n:4, f:0.005, o:0, u:'km', dp:3 },
    { spn:918, name:'HR Trip Distance',          b:4, n:4, f:0.005, o:0, u:'km', dp:3 },
  ]},
  // On request. Day and seconds are quarter-units per J1939-71; year is offset from 1985.
  0xFEE6:{ name:'Time/Date', abbr:'TD', spns:[
    { spn:959,  name:'Seconds', b:0, n:1, f:0.25, o:0,    u:'s',   dp:2 },
    { spn:960,  name:'Minutes', b:1, n:1, f:1,    o:0,    u:'min', dp:0 },
    { spn:961,  name:'Hours',   b:2, n:1, f:1,    o:0,    u:'h',   dp:0 },
    { spn:963,  name:'Month',   b:3, n:1, f:1,    o:0,    u:'',    dp:0 },
    { spn:962,  name:'Day',     b:4, n:1, f:0.25, o:0,    u:'',    dp:2 },
    { spn:964,  name:'Year',    b:5, n:1, f:1,    o:1985, u:'',    dp:0 },
    { spn:1601, name:'Local Minute Offset', b:6, n:1, f:1, o:-125, u:'min', dp:0 },
    { spn:1602, name:'Local Hour Offset',   b:7, n:1, f:1, o:-125, u:'h',   dp:0 },
  ]},
  0xFEDF:{ name:'Electronic Engine Controller 3', abbr:'EEC3', spns:[
    { spn:514, name:'Nominal Friction - Percent Torque',  b:0, n:1, f:1,     o:-125, u:'%',   dp:0 },
    { spn:515, name:"Engine's Desired Operating Speed",   b:1, n:2, f:0.125, o:0,    u:'rpm', dp:1 },
    { spn:519, name:'Desired Op. Speed Asymmetry Adjust', b:3, n:1, f:1,     o:0,    u:'',    dp:0 },
  ]},
  0xFEF8:{ name:'Transmission Fluids', abbr:'TF', spns:[
    { spn:123, name:'Clutch Pressure',                b:0, n:1, f:16,  o:0, u:'kPa', dp:0 },
    { spn:124, name:'Transmission Oil Level',         b:1, n:1, f:0.4, o:0, u:'%',   dp:0 },
    { spn:126, name:'Transmission Filter Diff. Pressure', b:2, n:1, f:2, o:0, u:'kPa', dp:0 },
    { spn:127, name:'Transmission Oil Pressure',      b:3, n:1, f:16,  o:0, u:'kPa', dp:0 },
    { spn:177, name:'Transmission Oil Temp',          b:4, n:2, f:0.03125, o:-273, u:'°C', dp:1 },
  ]},
  0xFE6E:{ name:'High Resolution Wheel Speed', abbr:'HRW', spns:[
    { spn:1592, name:'Front Left Wheel Speed',  b:0, n:2, f:1/256, o:0, u:'km/h', dp:2 },
    { spn:1593, name:'Front Right Wheel Speed', b:2, n:2, f:1/256, o:0, u:'km/h', dp:2 },
    { spn:1594, name:'Rear Left Wheel Speed',   b:4, n:2, f:1/256, o:0, u:'km/h', dp:2 },
    { spn:1595, name:'Rear Right Wheel Speed',  b:6, n:2, f:1/256, o:0, u:'km/h', dp:2 },
  ]},
  0xFEFF:{ name:'Water in Fuel Indicator', abbr:'WFI', spns:[
    { spn:97, name:'Water In Fuel', b:0, n:0, bit:0, bits:2, map:{0:'No',1:'Yes',2:'Error',3:'N/A'} },
  ]},
  0xFEA4:{ name:'Engine Temperature 2', abbr:'ET2', spns:[
    { spn:1135, name:'Engine Oil Temp 2', b:0, n:2, f:0.03125, o:-273, u:'°C',  dp:1 },
    { spn:1136, name:'Engine ECU Temp',   b:2, n:2, f:0.03125, o:-273, u:'°C',  dp:1 },
    { spn:411,  name:'EGR Diff. Pressure', b:4, n:2, f:1/128,  o:-250, u:'kPa', dp:2 },
    { spn:412,  name:'EGR Temp',          b:6, n:2, f:0.03125, o:-273, u:'°C',  dp:1 },
  ]},
  0xFEBD:{ name:'Fan Drive', abbr:'FD', spns:[
    { spn:975,  name:'Estimated Percent Fan Speed', b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
    { spn:977,  name:'Fan Drive State', b:1, n:0, bit:0, bits:4, map:{0:'Fan off',1:'Engine system - general',2:'Excessive engine air temp',3:'Excessive engine oil temp',4:'Excessive engine coolant temp',5:'Excessive transmission oil temp',6:'Excessive hydraulic oil temp',7:'Default operation',8:'Not defined',9:'Manual control',10:'Transmission retarder',11:'A/C system',12:'Timer',13:'Engine brake',14:'Other'} },
    { spn:1639, name:'Fan Speed', b:2, n:2, f:0.125, o:0, u:'rpm', dp:1 },
  ]},
  // One message per tire; SPN 929 says which (like VW's SPN 928 says which axle).
  0xFEF4:{ name:'Tire Condition', abbr:'TIRE', spns:[
    { spn:929,  name:'Tire Location',         b:0, n:1, f:1,       o:0,    u:'',     dp:0 },
    { spn:241,  name:'Tire Pressure',         b:1, n:1, f:4,       o:0,    u:'kPa',  dp:0 },
    { spn:242,  name:'Tire Temp',             b:2, n:2, f:0.03125, o:-273, u:'°C',   dp:1 },
    { spn:2586, name:'Tire Air Leakage Rate', b:5, n:2, f:0.1,     o:0,    u:'Pa/s', dp:1 },
  ]},
  // ── The J1939-21 request pair ────────────────────────────────────────────────
  // Both carry a 24-bit PGN in the payload, which the byte-scaled SPN model cannot render as
  // anything but a decimal number - so both get a custom `decode`, the escape hatch the ISOBUS
  // TC/VT entries already use. Layouts and the priority-6 default are J1939-21's.
  0xEA00:{ name:'Request', abbr:'RQST', decode:(d) => d.length < 3 ? [] : [
    { name:'Requested PGN', display: j1939PgnLabel((d[0] | (d[1] << 8) | (d[2] << 16)) >>> 0), valid:true } ]},
  0xE800:{ name:'Acknowledgment', abbr:'ACKM', decode:(d) => d.length < 8 ? [] : [
    { name:'Control byte', display: J1939_ACK_CTRL[d[0]] || String(d[0]), valid:true },
    { name:'Group function', display: d[1] === 0xFF ? 'N/A' : String(d[1]), valid:true },
    { name:'Address', display: d[4] === 0xFF ? 'N/A' : '0x' + j1939H(d[4]), valid:true },
    { name:'Requested PGN', display: j1939PgnLabel((d[5] | (d[6] << 8) | (d[7] << 16)) >>> 0), valid:true } ]},
  // Name lookup only: j1939.js consumes these three itself (NAME table, TP reassembly) and never
  // dispatches them as PGNs; the explainer names them from here.
  0xEE00:{ name:'Address Claimed', abbr:'AC', spns:[] },
  // ISO 11992-2 trailer messages, which share this id space (iso11992.js packs them). They are not
  // SAE parameters, so no SPN numbers. Field positions are EU 2015/68 Annex XII's / UN R13's quoting
  // of the standard; the two PGNs are SECONDARY-sourced - see iso11992.js's provenance header.
  0x0300:{ name:'ISO 11992 EBS21 - towed to towing vehicle', abbr:'EBS21', spns:[
    { name:'VDC active/passive', b:1, n:0, bit:0, bits:2, map:{0:'Passive',1:'Active',2:'Error',3:'N/A'} },
  ]},
  0xFEC4:{ name:'ISO 11992 EBS22 - towed to towing vehicle', abbr:'EBS22', spns:[
    { name:'Vehicle ABS active/passive', b:0, n:0, bit:0, bits:2, map:{0:'Passive',1:'Active',2:'Error',3:'N/A'} },
  ]},
  0xEC00:{ name:'Transport Protocol - Connection Management', abbr:'TP.CM', spns:[] },
  0xEB00:{ name:'Transport Protocol - Data Transfer', abbr:'TP.DT', spns:[] },
  // DM1/DM2 handled separately; entries here provide name lookup only
  0xFECA:{ name:'Active DTCs (DM1)',           abbr:'DM1', spns:[] },
  0xFECB:{ name:'Previously Active DTCs (DM2)', abbr:'DM2', spns:[] },
  0xFECC:{ name:'Clear Previously Active DTCs (DM3)', abbr:'DM3', spns:[] },
  // Multi-packet messages (TP reassembly required)
  0xFEEC:{ name:'Vehicle Identification (VIN)', abbr:'VI',   spns:[] },
  0xFEDA:{ name:'Software Identification',      abbr:'SOFT', spns:[] },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function j1939H(v, w = 2) { return v.toString(16).toUpperCase().padStart(w, '0'); }

// J1939-21 acknowledgment control byte (PGN 59392, byte 1).
const J1939_ACK_CTRL = { 0:'ACK', 1:'NACK', 2:'Access Denied', 3:'Cannot Respond' };

// Name of a PGN in the dictionary the J1939 tab has selected (j1939.js defines j1939ActiveDb);
// a page without that tab (the explainers) names it out of J1939_DB.
function j1939PgnLabel(pgn) {
  const e = (typeof j1939ActiveDb === "function" ? j1939ActiveDb() : J1939_DB)[pgn];
  return e ? `${e.abbr} – ${e.name}` : `PGN ${j1939H(pgn, 4)}`;
}

// ── ID Parsing ────────────────────────────────────────────────────────────────
// J1939 always uses 29-bit extended IDs.
// Layout: [28:26] Priority | [25] Reserved | [24] Data Page |
//         [23:16] PDU Format (PF) | [15:8] PDU Specific (PS) | [7:0] Source Address
// PDU1 (PF < 0xF0): PS = destination address; PGN does NOT include PS
// PDU2 (PF ≥ 0xF0): PS is part of PGN; message is broadcast
// -> { priority, dp, pf, pgn, da, sa }. The rule itself is j1939-pack.js's (the one copy, shared with
// every packer), so a page that loads this file loads ../j1939-pack.js first.
function j1939ParseId(id) { return J1939Pack.parseId(id); }

// ── SPN Decode ────────────────────────────────────────────────────────────────
function j1939DecodeSPN(def, data) {
  if (def.n === 0) {
    // Bit-level SPN
    if (data.length <= def.b) return null;
    const raw = (data[def.b] >> def.bit) & ((1 << def.bits) - 1);
    const allOnes = (1 << def.bits) - 1;
    if (raw === allOnes && !def.onesValid) return { name: def.name, display: 'N/A', valid: false };
    return { name: def.name, display: def.map?.[raw] ?? String(raw), valid: true };
  }
  if (data.length < def.b + def.n) return null;
  let raw = 0;
  // Build LE unsigned with `* 2**` (not `<<`): a 4-byte field's top byte shifted <<24 goes negative
  // before the later >>>0, an easy footgun. `+=`/`*` keeps it a correct positive int (< 2^53).
  for (let i = 0; i < def.n; i++) raw += data[def.b + i] * 2 ** (8 * i);
  // J1939-71 Table 1 ranges go by the MOST significant byte: 0x00-0xFA valid, 0xFB parameter-
  // specific indicator, 0xFC-0xFD reserved, 0xFE error indicator, 0xFF not available.
  const top = data[def.b + def.n - 1];
  if (top === 0xFF) return { name: def.name, display: 'N/A', valid: false };
  if (top === 0xFE) return { name: def.name, display: 'Error', valid: false };
  if (top === 0xFB) return { name: def.name, display: `Param-specific 0x${j1939H(raw, def.n * 2)}`, valid: true };
  if (top > 0xFA)   return { name: def.name, display: 'Reserved', valid: false };
  const val = raw * def.f + def.o;
  const display = val.toFixed(def.dp ?? 1) + (def.u ? ' ' + def.u : '');
  return { name: def.name, display, valid: true };
}

// ── DM1/DM2 Decode ────────────────────────────────────────────────────────────
// Each DTC is 4 bytes:
//   Byte 0:      SPN bits  7:0
//   Byte 1:      SPN bits 15:8
//   Byte 2[7:5]: SPN bits 18:16  |  Byte 2[4:0]: FMI
//   Byte 3[7]:   CM (conversion method)  |  Byte 3[6:0]: occurrence count
// One 4-byte record (DM1/DM2 bytes 3-6, 7-10, ...). cm = 1 is the current SPN conversion method,
// the only one this layout is right for; cm = 0 records are shown with the same split.
function j1939DecodeDTC(b0, b1, b2, b3) {
  const spn = b0 | (b1 << 8) | ((b2 >> 5) << 16);
  const fmi = b2 & 0x1F;
  return {
    spn, fmi, oc: b3 & 0x7F, cm: (b3 >> 7) & 1,
    fmiDesc: J1939_FMI[fmi] || `FMI ${fmi}`,
    raw: [b0, b1, b2, b3],
  };
}
function j1939DecodeDTCs(data) {
  const dtcs = [];
  for (let i = 2; i + 3 < data.length; i += 4) {
    const d = j1939DecodeDTC(data[i], data[i+1], data[i+2], data[i+3]);
    if (d.spn === 0 && d.fmi === 0) continue;
    dtcs.push(d);
  }
  return dtcs;
}

// ── Address Claim (NAME) Decode ───────────────────────────────────────────────
// The NAME is a 64-bit value transmitted little-endian (byte 0 = LSB).
// Bit layout, per SAE J1939-81:
//   Bits  0-20: Identity Number   (21 bits)
//   Bits 21-31: Manufacturer Code (11 bits)
//   Bits 32-34: ECU Instance      ( 3 bits)
//   Bits 35-39: Function Instance ( 5 bits)
//   Bits 40-47: Function          ( 8 bits)
//   Bit     48: Reserved
//   Bits 49-55: Vehicle System    ( 7 bits) - the ISO 11783 / NMEA 2000 device class
//   Bits 56-59: Vehicle Sys Inst  ( 4 bits)
//   Bits 60-62: Industry Group    ( 3 bits)
//   Bit     63: Arbitrary Addr Cap( 1 bit)
// The last two used to be read at bits 57-59 and 60, which put the industry group three bits
// low and the self-configurable flag three bits early - so every claim decoded with the wrong
// industry (and therefore the wrong device-class table). Corrected against J1939-81 when
// isobus.js needed to WRITE a NAME; the two synthesised claims in j1939.js's demo moved with it.
function j1939DecodeName(data) {
  if (data.length < 8) return null;
  // Split into two 32-bit words (bits 0-31 and bits 32-63)
  const lo = (data[0] | (data[1]<<8) | (data[2]<<16) | (data[3]<<24)) >>> 0;
  const hi = (data[4] | (data[5]<<8) | (data[6]<<16) | (data[7]<<24)) >>> 0;
  const fn          = (hi >>> 8)  & 0xFF;
  const industryGrp = (hi >>> 28) & 0x07;
  const ecuInst     = hi          & 0x07;
  const mfrCode     = (lo >>> 21) & 0x7FF;
  const arbitrary   = (hi >>> 31) & 0x01;
  const devClass    = (hi >>> 17) & 0x7F; // NAME bits 49–55 (device class / vehicle system)
  const identity    = lo & 0x1FFFFF;
  return {
    identity, fn, mfrCode, ecuInst, industryGrp, arbitrary, devClass,
    fnName:       J1939_FUNCTION[fn]     || `Function ${fn}`,
    industryName: J1939_INDUSTRY[industryGrp] || `Group ${industryGrp}`,
  };
}

// ── NMEA 2000 ─────────────────────────────────────────────────────────────────
// NMEA 2000 is J1939 at the wire level (29-bit IDs, PDU1/PDU2 PGN extraction,
// ISO Address Claim). What differs: a marine PGN dictionary, the Fast Packet
// multi-frame transport, and bit-packed fields that straddle byte boundaries -
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
// Lookups for 127237 Heading/Track Control - a Rudder/autopilot flavor packer (nmea2000.js)
// needs these to name the frames it emits, so they live beside N2K_DIR_REF rather than inline.
const N2K_YESNO      = { 0:'No', 1:'Yes', 2:'Error', 3:'Unavailable' };
const N2K_STEER_MODE = { 0:'Main Steering', 1:'Non-Follow-up Device', 2:'Follow-up Device',
                          3:'Heading Control Standalone', 4:'Heading Control', 5:'Track Control' };
const N2K_TURN_MODE  = { 0:'Rudder Limit Controlled', 1:'Turn Radius Controlled', 2:'Rate of Turn Controlled' };
// 130577 Direction Data.
const N2K_DATA_MODE  = { 0:'Autonomous', 1:'Differential Enhanced', 2:'Estimated', 3:'Simulator', 4:'Manual' };

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
  // Single-frame. Layout (Instance / Direction Order + 5 reserved bits / Angle Order / Position
  // / 2 reserved bytes) is ttlappalainen's NMEA2000 library (N2kMessages.cpp
  // SetN2kPGN127245) - the closest thing to a public reference for a PGN NMEA's own documents
  // keep behind a paywall, and the one the nmea2000.js flavor packer's Rudder frame is built
  // against. Direction Order has no source in this game (only the resulting angle), so a packer
  // leaves it at 7 = Unavailable rather than inventing "No Order".
  127245:{ name:'Rudder', abbr:'127245', fp:false, fields:[
    { name:'Instance', bo:0, bl:8 },
    { name:'Direction Order', bo:8, bl:3, map:{0:'No Order',1:'Move to Starboard',2:'Move to Port'} },
    { name:'Angle Order', bo:16, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Position', bo:32, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 } ]},
  // Fast Packet, 21 bytes. Same source as 127245 (SetN2kPGN127237). Only Steering Mode and
  // Heading-To-Steer have a source in this game (nav_mode_actual / heading_target); every other
  // field - the three limit-exceeded flags, Override, Turn Mode, Heading Reference, Commanded
  // Rudder Direction/Angle, Track, the two limits, the two turn orders and Off-Track Limit -
  // stays "not available", because nothing here is a route/track-control system (the contract's
  // own words: "HEADING HOLD AND NOTHING MORE - no routes and no cross-track error").
  127237:{ name:'Heading/Track Control', abbr:'127237', fp:true, fields:[
    { name:'Rudder Limit Exceeded', bo:0, bl:2, map:N2K_YESNO },
    { name:'Off-Heading Limit Exceeded', bo:2, bl:2, map:N2K_YESNO },
    { name:'Off-Track Limit Exceeded', bo:4, bl:2, map:N2K_YESNO },
    { name:'Override', bo:6, bl:2, map:N2K_YESNO },
    { name:'Steering Mode', bo:8, bl:3, map:N2K_STEER_MODE },
    { name:'Turn Mode', bo:11, bl:3, map:N2K_TURN_MODE },
    { name:'Heading Reference', bo:14, bl:2, map:N2K_DIR_REF },
    { name:'Commanded Rudder Direction', bo:17, bl:3, map:{0:'No Order',1:'Move to Starboard',2:'Move to Port'} },
    { name:'Commanded Rudder Angle', bo:24, bl:16, signed:true, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Heading-To-Steer (Course)', bo:40, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Track', bo:56, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Rudder Limit', bo:72, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Off-Heading Limit', bo:88, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Radius of Turn Order', bo:104, bl:16, signed:true, scale:1, unit:'m', dp:0 },
    { name:'Rate of Turn Order', bo:120, bl:16, signed:true, scale:3.125e-5*RAD2DEG, unit:'°/s', dp:2 },
    { name:'Off-Track Limit', bo:136, bl:16, signed:true, scale:1, unit:'m', dp:0 },
    { name:'Vessel Heading', bo:152, bl:16, scale:N2K_ANG, unit:'°', dp:1 } ]},
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
  // Fast Packet, 14 bytes. Same source as 127245/127237 (SetN2kPGN130577). COG/SOG/Heading/
  // Speed Through Water all stay "not available": each already has its own dedicated PGN
  // (129026, 128259) with its own SA in nmea2000.js, and repeating the same number here under
  // a second identity is the 'odo' problem isobus.js's speed messages already avoid.
  130577:{ name:'Direction Data', abbr:'130577', fp:true, fields:[
    { name:'Data Mode', bo:0, bl:4, map:N2K_DATA_MODE },
    { name:'COG Reference', bo:4, bl:2, map:N2K_DIR_REF },
    { name:'COG', bo:16, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'SOG', bo:32, bl:16, scale:0.01, unit:'m/s', dp:2 },
    { name:'Heading', bo:48, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Speed Through Water', bo:64, bl:16, scale:0.01, unit:'m/s', dp:2 },
    { name:'Set', bo:80, bl:16, scale:N2K_ANG, unit:'°', dp:1 },
    { name:'Drift', bo:96, bl:16, scale:0.01, unit:'m/s', dp:2 } ]},
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
// transport - the Extended Transport Protocol (ETP) for messages > 1785 bytes.
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
// Virtual Terminal message function byte (ISO 11783-6) - labelled, not rendered.
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
    { name:'DDI', display: `0x${j1939H(ddi,4)}${ISOBUS_DDI[ddi] ? ' - ' + ISOBUS_DDI[ddi] : ''}`, valid:true },
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
  // ── The ag PGNs, as the ISOBUS Data Dictionary defines them ─────────────────
  // THE PTO AND HITCH PAIRS USED TO BE THE WRONG WAY ROUND HERE: 0xFE43 (65091) is the rear
  // PTO and 0xFE45 (65093) is the rear hitch, not the reverse, so a real tractor's frames
  // decoded under each other's names with plausible-looking numbers. Field positions, SPN
  // numbers and scalings below all come off isobus.net; the direction bits in particular sat
  // at 8.7 (which is SPN 5244, "operator direction reversed") rather than 8.1.
  0xFE48:{ name:'Wheel-based Speed and Distance', abbr:'WBSD', spns:[
    { spn:1862, name:'Wheel-based machine speed',    b:0, n:2, f:0.001, o:0, u:'m/s', dp:3 },
    { spn:1863, name:'Wheel-based machine distance', b:2, n:4, f:0.001, o:0, u:'m',   dp:0 },
    { spn:1866, name:'Maximum Time of Tractor Power', b:6, n:1, f:1, o:0, u:'min', dp:0 },
    { spn:1864, name:'Wheel-based machine direction', b:7, n:0, bit:0, bits:2, map:{0:'Reverse',1:'Forward',2:'Error',3:'N/A'} },
    { spn:1865, name:'Key switch state', b:7, n:0, bit:2, bits:2, map:{0:'Off',1:'Not off',2:'Error',3:'N/A'} },
    { spn:5203, name:'Implement Start/Stop operations', b:7, n:0, bit:4, bits:2, map:{0:'Stop',1:'Permit',2:'Error',3:'N/A'} },
    { spn:5244, name:'Operator direction reversed', b:7, n:0, bit:6, bits:2, map:{0:'Not reversed',1:'Reversed',2:'Error',3:'N/A'} },
  ]},
  0xFE49:{ name:'Ground-based Speed and Distance', abbr:'GBSD', spns:[
    { spn:1859, name:'Ground-based machine speed',    b:0, n:2, f:0.001, o:0, u:'m/s', dp:3 },
    { spn:1860, name:'Ground-based machine distance', b:2, n:4, f:0.001, o:0, u:'m',   dp:0 },
    { spn:1861, name:'Ground-based machine direction', b:7, n:0, bit:0, bits:2, map:{0:'Reverse',1:'Forward',2:'Error',3:'N/A'} },
  ]},
  0xFE43:{ name:'Primary or Rear Power Take off Output Shaft', abbr:'RPTO', spns:[
    { spn:1883, name:'Rear PTO output shaft speed',     b:0, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { spn:1885, name:'Rear PTO shaft speed set point',  b:2, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { spn:5156, name:'Rear PTO engagement request status', b:4, n:0, bit:0, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
    { spn:1892, name:'Rear PTO economy mode',  b:4, n:0, bit:2, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:1890, name:'Rear PTO mode',          b:4, n:0, bit:4, bits:2, map:{0:'540',1:'1000',2:'Error',3:'N/A'} },
    { spn:2408, name:'Rear PTO engagement',    b:4, n:0, bit:6, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
  ]},
  0xFE44:{ name:'Secondary or Front Power Take off Output Shaft', abbr:'FPTO', spns:[
    { spn:1882, name:'Front PTO output shaft speed',    b:0, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { spn:1884, name:'Front PTO shaft speed set point', b:2, n:2, f:0.125, o:0, u:'rpm', dp:1 },
    { spn:5152, name:'Front PTO engagement request status', b:4, n:0, bit:0, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
    { spn:1891, name:'Front PTO economy mode', b:4, n:0, bit:2, bits:2, map:{0:'Off',1:'On',2:'Error',3:'N/A'} },
    { spn:1889, name:'Front PTO mode',         b:4, n:0, bit:4, bits:2, map:{0:'540',1:'1000',2:'Error',3:'N/A'} },
    { spn:1888, name:'Front PTO engagement',   b:4, n:0, bit:6, bits:2, map:{0:'Disengaged',1:'Engaged',2:'Error',3:'N/A'} },
  ]},
  0xFE45:{ name:'Primary or Rear Hitch Status', abbr:'RHS', spns:[
    { spn:1873, name:'Rear Hitch Position', b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
    { spn:5151, name:'Rear Hitch Position Limit status', b:1, n:0, bit:3, bits:3 },
    { spn:1877, name:'Rear Hitch In-work Indication', b:1, n:0, bit:6, bits:2, map:{0:'Out of Work',1:'In Work',2:'Error',3:'N/A'} },
    // 0.8 %/bit over -100..+100 %, so it is a SIGNED reading in an unsigned byte - the field
    // isobus.js puts the contract's `draft_force` in.
    { spn:1881, name:'Rear Nominal Lower Link Force', b:2, n:1, f:0.8, o:-100, u:'%', dp:0 },
    { spn:1879, name:'Rear Draft', b:3, n:2, f:10, o:-320000, u:'N', dp:0 },
  ]},
  0xFE46:{ name:'Secondary or Front Hitch Status', abbr:'FHS', spns:[
    { spn:1872, name:'Front Hitch Position', b:0, n:1, f:0.4, o:0, u:'%', dp:0 },
    { spn:5150, name:'Front Hitch Position Limit status', b:1, n:0, bit:3, bits:3 },
    { spn:1876, name:'Front Hitch In-work Indication', b:1, n:0, bit:6, bits:2, map:{0:'Out of Work',1:'In Work',2:'Error',3:'N/A'} },
    { spn:1880, name:'Front Nominal Lower Link Force', b:2, n:1, f:0.8, o:-100, u:'%', dp:0 },
    { spn:1878, name:'Front Draft', b:3, n:2, f:10, o:-320000, u:'N', dp:0 },
  ]},
  0xFEE8:{ name:'Vehicle Direction/Speed', abbr:'VDS', spns:[
    { spn:165, name:'Compass Bearing', b:0, n:2, f:1/128, o:0,     u:'°',    dp:1 },
    { spn:517, name:'Navigation-Based Vehicle Speed', b:2, n:2, f:1/256, o:0, u:'km/h', dp:1 },
    { spn:583, name:'Pitch',           b:4, n:2, f:1/128, o:-200,  u:'°',    dp:1 },
    { spn:580, name:'Altitude',        b:6, n:2, f:0.125, o:-2500, u:'m',    dp:1 },
  ]},
  0xCB00:{ name:'Task Controller / Process Data', abbr:'PD', decode: isoTcDecode },
  0xE600:{ name:'VT → ECU', abbr:'VT→ECU', decode: isoVtDecode },
  0xE700:{ name:'ECU → VT', abbr:'ECU→VT', decode: isoVtDecode },
  0xEA00:{ name:'Request PGN', abbr:'RQST', fields:[ { name:'Requested PGN', bo:0, bl:24 } ]},
  0xFED8:{ name:'Commanded Address', abbr:'CA', fields:[ { name:'New Address', bo:64, bl:8 } ]},
  // Auxiliary valve block - labelled (decode is application-specific / DDL-driven). The valves
  // occupy three contiguous runs of sixteen PGNs, per isobus.net: 65040-65055 estimated flow,
  // 65056-65071 measured flow, 65072-65087 command. The three entries that used to be here
  // named 0xFE2F / 0xFE2E / 0xFE24 as valves 0 and 1 and "the" command PGN, which put all
  // three in the measured-flow run under the wrong names.
  0xFE10:{ name:'Auxiliary Valve 0 Estimated Flow', abbr:'AUX0E', spns:[] },
  0xFE11:{ name:'Auxiliary Valve 1 Estimated Flow', abbr:'AUX1E', spns:[] },
  0xFE20:{ name:'Auxiliary Valve 0 Measured Flow',  abbr:'AUX0M', spns:[] },
  0xFE30:{ name:'Auxiliary Valve 0 Command',        abbr:'AUX0C', spns:[] },
};

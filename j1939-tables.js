// ── J1939 reference tables + pure decoders (shared) ─────────────────────────────
// The ONE copy of the J1939 dictionary: source addresses, FMIs, NAME functions and industry
// groups, the PGN/SPN database, and the DOM-free decoders that read them. No DOM, no state, no
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
  0x22:'Auxiliary Valve Control', 0x23:'Hitch Control',
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
    { spn:523, name:'Current Gear',  b:3, n:1, f:1, o:-125, u:'', dp:0 },
  ]},
  // The driver-demand groups j1939-flavor.js decodes into Carlito's accel / brake / steer / gear
  // (and the demo sends from the RAMN Control Panel). Positions off J1939-71.
  0xF001:{ name:'Electronic Brake Controller 1', abbr:'EBC1', spns:[
    { spn:521, name:'Brake Pedal Position', b:1, n:1, f:0.4, o:0, u:'%', dp:0 },
  ]},
  0xF009:{ name:'Vehicle Dynamic Stability Control 2', abbr:'VDC2', spns:[
    { spn:1807, name:'Steering Wheel Angle', b:0, n:2, f:1/1024, o:-31.374, u:'rad', dp:3 },
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
  return { spn, fmi, oc: b3 & 0x7F, cm: (b3 >> 7) & 1, fmiDesc: J1939_FMI[fmi] || `FMI ${fmi}` };
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

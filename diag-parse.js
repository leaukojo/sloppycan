// ── diag-parse.js - OBD-II / UDS / KWP2000 decoders + reference tables ────────
//
// Extracted from sloppycan.js: the pure diagnostic-payload parsers and their
// lookup tables (no DOM ownership, no bus state). This is the one acyclic, near-
// dependency-free boundary in the codebase - everything here is either a plain
// data table or a hoisted decode function.
//
// LOAD ORDER: this script is loaded (non-defer) immediately *before* sloppycan.js
// so its tables exist by the time sloppycan.js evaluates KWP_PALETTE / UDS_PALETTE
// (which reference KWP_DIAG_MODE / UDS_SESSION / UDS_RESET / ... at eval time).
//
// Outbound deps into core (both read at call time, so safe despite core loading
// after this file): escHtml() (DOM helper) and obdProtoMode (the UDS/OBD/KWP mode).

// ── OBD-II / ISO 15031 / SAE J1979 Parser ────────────────────────────────────
const OBD_MODE = {
  0x01:'Show Current Data', 0x02:'Show Freeze Frame Data',
  0x03:'Show Stored DTCs', 0x04:'Clear DTCs & Reset MIL',
  0x05:'O2 Sensor Test Results', 0x06:'On-Board System Test Results',
  0x07:'Show Pending DTCs', 0x08:'Control On-Board System',
  0x09:'Request Vehicle Info', 0x0A:'Permanent DTCs',
};
const OBD_PID01 = {
  0x00:'Supported PIDs [01–20]', 0x01:'Monitor status since DTCs cleared',
  0x03:'Fuel system status', 0x04:'Calculated engine load (%)',
  0x05:'Engine coolant temp (°C)', 0x06:'Short term fuel trim B1 (%)',
  0x07:'Long term fuel trim B1 (%)', 0x08:'Short term fuel trim B2 (%)',
  0x09:'Long term fuel trim B2 (%)', 0x0A:'Fuel pressure (kPa)',
  0x0B:'Intake manifold pressure (kPa)', 0x0C:'Engine RPM (rpm)',
  0x0D:'Vehicle speed (km/h)', 0x0E:'Timing advance (° before TDC)',
  0x0F:'Intake air temperature (°C)', 0x10:'Mass air flow rate (g/s)',
  0x11:'Throttle position (%)', 0x12:'Commanded secondary air status',
  0x13:'O2 sensors present (B1–B2)', 0x1C:'OBD standards compliance',
  0x1F:'Run time since engine start (s)', 0x20:'Supported PIDs [21–40]',
  0x21:'Distance traveled with MIL on (km)', 0x22:'Fuel rail pressure (kPa rel.)',
  0x23:'Fuel rail pressure (kPa gauge)', 0x2C:'Commanded EGR (%)',
  0x2D:'EGR error (%)', 0x2E:'Commanded evaporative purge (%)',
  0x2F:'Fuel tank level (%)', 0x30:'Warm-ups since codes cleared',
  0x31:'Distance since codes cleared (km)', 0x33:'Absolute barometric pressure (kPa)',
  0x3C:'Catalyst temperature B1S1 (°C)', 0x40:'Supported PIDs [41–60]',
  0x41:'Monitor status this drive cycle', 0x42:'Control module voltage (V)',
  0x43:'Absolute load value (%)', 0x44:'Commanded air-fuel equivalence ratio',
  0x45:'Relative throttle position (%)', 0x46:'Ambient air temperature (°C)',
  0x47:'Absolute throttle pos B (%)', 0x4D:'Time run with MIL on (min)',
  0x4E:'Time since DTC cleared (min)', 0x51:'Fuel type',
  0x52:'Ethanol fuel content (%)', 0x60:'Supported PIDs [61–80]',
  0x67:'Engine coolant temp (multi-sensor)', 0x68:'Intake air temp (multi-sensor)',
};
const OBD_PID09 = {
  0x00:'Supported PIDs', 0x02:'Vehicle Identification Number (VIN)',
  0x04:'Calibration ID', 0x06:'Calibration Verification Number (CVN)',
  0x0A:'ECU name', 0x0B:'ECU name (in-use perf. tracking)',
};

// Decode one Mode-01 (current data) / Mode-02 (freeze frame) PID value.
// `d` is the data bytes *after* the PID (and after the frame-# byte for Mode 02).
// Returns {k,v} or null (caller renders raw hex when null).
function obdM01Value(pid, d) {
  switch (pid) {
    case 0x04: return {k:'Engine load',     v:`${Math.round(d[0]*100/255)} %`};
    case 0x05: return {k:'Coolant temp',    v:`${d[0]-40} °C`};
    case 0x06: case 0x07: case 0x08: case 0x09:
               return {k:'Fuel trim',       v:`${((d[0]-128)*100/128).toFixed(1)} %`};
    case 0x0B: return {k:'MAP pressure',    v:`${d[0]} kPa`};
    case 0x0C: return d.length>=2 ? {k:'RPM', v:`${((d[0]<<8)|d[1])/4} rpm`} : null;
    case 0x0D: return {k:'Speed',           v:`${d[0]} km/h`};
    case 0x0E: return {k:'Timing advance',  v:`${d[0]/2-64} ° before TDC`};
    case 0x0F: return {k:'Intake air temp', v:`${d[0]-40} °C`};
    case 0x10: return d.length>=2 ? {k:'MAF', v:`${((d[0]<<8)|d[1])/100} g/s`} : null;
    case 0x11: return {k:'Throttle',        v:`${Math.round(d[0]*100/255)} %`};
    case 0x14: case 0x15: case 0x16: case 0x17:
    case 0x18: case 0x19: case 0x1A: case 0x1B:
               return d.length>=2 ? {k:'O2 sensor', v:`${(d[0]/200).toFixed(3)} V · trim ${((d[1]-128)*100/128).toFixed(1)} %`}
                                  : {k:'O2 sensor', v:`${(d[0]/200).toFixed(3)} V`};
    case 0x2F: return {k:'Fuel level',      v:`${Math.round(d[0]*100/255)} %`};
    case 0x33: return {k:'Baro pressure',   v:`${d[0]} kPa`};
    case 0x42: return d.length>=2 ? {k:'Voltage', v:`${((d[0]<<8)|d[1])/1000} V`} : null;
    case 0x46: return {k:'Ambient temp',    v:`${d[0]-40} °C`};
    case 0x49: case 0x4A: case 0x4B: case 0x4C:
               return {k:'Pedal/throttle',  v:`${Math.round(d[0]*100/255)} %`};
    case 0x52: return {k:'Ethanol content', v:`${Math.round(d[0]*100/255)} %`};
    case 0x5C: return {k:'Oil temp',        v:`${d[0]-40} °C`};
    case 0x5E: return d.length>=2 ? {k:'Fuel rate', v:`${(((d[0]<<8)|d[1])/20).toFixed(1)} L/h`} : null;
    default:   return null;
  }
}

function obdDecode(bytes) {
  if (!bytes || !bytes.length) return null;
  const mode = bytes[0];
  const isResp  = mode >= 0x41 && mode <= 0x4A;
  const rawMode = isResp ? mode - 0x40 : mode;
  if (rawMode < 0x01 || rawMode > 0x0A) return null;
  const modeName = OBD_MODE[rawMode] || `Mode ${udsH(rawMode)}`;
  const rows = [
    {k:'Protocol', v:'OBD-II (ISO 15031 / SAE J1979)'},
    {k:'Mode',     v:`${udsH(rawMode)}  ${modeName}`},
  ];
  const add = (k,v) => rows.push({k,v});
  let summary = `OBD-II Mode ${udsH(rawMode)} · ${modeName}`;

  if (rawMode === 0x03 || rawMode === 0x07 || rawMode === 0x0A) {
    // No PID - just DTC request/list
    if (isResp && bytes.length > 1) {
      const dtcs = [];
      for (let i = 1; i + 1 < bytes.length; i += 2) {
        const w = (bytes[i] << 8) | bytes[i+1];
        if (w === 0) continue;
        const prefix = ['P','C','B','U'][(w >> 14) & 3];
        dtcs.push(prefix + ((w >> 12) & 3).toString() + ((w >> 8) & 0xF).toString(16).toUpperCase()
                  + ((w >> 4) & 0xF).toString(16).toUpperCase() + (w & 0xF).toString(16).toUpperCase());
      }
      if (dtcs.length) rows.push({ k:'DTCs', v:dtcs.join('  '), vHtml:dtcs.map(c => dtcLink(c, `q=${c}&fmt=obdcode`)).join('  ') });
      else add('DTCs', 'none');
      summary = `OBD-II Response · ${modeName}${dtcs.length ? ' · ' + dtcs.join(' ') : ' · none'}`;
    }
  } else if (rawMode === 0x04) {
    summary = isResp ? 'OBD-II Response · DTCs cleared' : 'OBD-II Clear DTCs & Reset MIL';
  } else if (rawMode === 0x06) {
    // On-board monitoring test results - standardized record:
    // MID, TID, UASID, value(2), min(2), max(2)
    if (bytes.length > 1) {
      const mid = bytes[1];
      add('MID', udsH(mid));
      summary = `OBD-II Mode 06${isResp ? ' Response' : ''} · MID ${udsH(mid)}`;
      if (isResp && bytes.length >= 10) {
        const tid = bytes[2], uas = bytes[3];
        const val = (bytes[4]<<8)|bytes[5], mn = (bytes[6]<<8)|bytes[7], mx = (bytes[8]<<8)|bytes[9];
        add('TID', udsH(tid));
        add('Value', `${val}  (min ${mn} / max ${mx}, UAS ${udsH(uas)})`);
        add('Result', (val >= mn && val <= mx) ? 'PASS' : 'FAIL');
      } else if (isResp && bytes.length > 2) {
        add('Data', udsBytesHex(bytes.slice(2)));
      }
    }
  } else if (bytes.length > 1) {
    const pid = bytes[1];
    const pidMap = (rawMode === 0x01 || rawMode === 0x02) ? OBD_PID01 : rawMode === 0x09 ? OBD_PID09 : {};
    const pidName = pidMap[pid] || null;
    add('PID', `${udsH(pid)}  ${pidName || '(unknown)'}`);
    summary = `OBD-II Mode ${udsH(rawMode)} PID ${udsH(pid)}${pidName ? ' · ' + pidName : ''}`;
    if (isResp && bytes.length > 2) {
      // Mode 02 (freeze frame) carries a frame-number byte before the data
      let d, frameNo = null;
      if (rawMode === 0x02) { frameNo = bytes[2]; d = bytes.slice(3); add('Frame #', udsH(frameNo)); }
      else d = bytes.slice(2);
      if (rawMode === 0x01 || rawMode === 0x02) {
        const r = obdM01Value(pid, d);
        if (r) add(r.k, r.v); else add('Data', udsBytesHex(d));
      } else if (rawMode === 0x09 && pid === 0x02) {
        // VIN is ASCII - filter to printable, dropping any leading count byte
        try { add('VIN', d.filter(b=>b>=0x20&&b<0x7F).map(b=>String.fromCharCode(b)).join('').trim()); }
        catch(e) { add('Data', udsBytesHex(d)); }
      } else {
        add('Data', udsBytesHex(d));
      }
      summary = `OBD-II Response · Mode ${udsH(rawMode)} PID ${udsH(pid)}${pidName ? ' · ' + pidName : ''}`;
    }
  }
  return { type: isResp ? 'positive' : 'request', summary, rows };
}

// ── UDS / ISO 14229-1 Parser ─────────────────────────────────────────────────
const UDS_SVC = {
  0x10:'DiagnosticSessionControl', 0x11:'ECUReset',
  0x14:'ClearDiagnosticInformation', 0x19:'ReadDTCInformation',
  0x22:'ReadDataByIdentifier', 0x23:'ReadMemoryByAddress',
  0x24:'ReadScalingDataByIdentifier', 0x27:'SecurityAccess',
  0x28:'CommunicationControl', 0x29:'Authentication',
  0x2A:'ReadDataByPeriodicIdentifier', 0x2C:'DynamicallyDefineDataIdentifier',
  0x2E:'WriteDataByIdentifier', 0x2F:'InputOutputControlByIdentifier',
  0x31:'RoutineControl', 0x34:'RequestDownload', 0x35:'RequestUpload',
  0x36:'TransferData', 0x37:'RequestTransferExit', 0x38:'RequestFileTransfer',
  0x3D:'WriteMemoryByAddress', 0x3E:'TesterPresent',
  0x83:'AccessTimingParameter', 0x84:'SecuredDataTransmission',
  0x85:'ControlDTCSetting', 0x86:'ResponseOnEvent', 0x87:'LinkControl',
};
const UDS_NRC = {
  0x10:'generalReject', 0x11:'serviceNotSupported',
  0x12:'subFunctionNotSupported', 0x13:'incorrectMessageLengthOrInvalidFormat',
  0x14:'responseTooLong', 0x21:'busyRepeatRequest', 0x22:'conditionsNotCorrect',
  0x24:'requestSequenceError', 0x25:'noResponseFromSubnetComponent',
  0x26:'failurePreventsExecutionOfRequestedAction', 0x31:'requestOutOfRange',
  0x33:'securityAccessDenied', 0x34:'authenticationRequired',
  0x35:'invalidKey', 0x36:'exceededNumberOfAttempts',
  0x37:'requiredTimeDelayNotExpired', 0x70:'uploadDownloadNotAccepted',
  0x71:'transferDataSuspended', 0x72:'generalProgrammingFailure',
  0x73:'wrongBlockSequenceCounter',
  0x78:'requestCorrectlyReceivedResponsePending',
  0x7E:'subFunctionNotSupportedInActiveSession',
  0x7F:'serviceNotSupportedInActiveSession',
};
const UDS_SESSION = {0x01:'defaultSession',0x02:'programmingSession',0x03:'extendedDiagnosticSession',0x04:'safetySystemDiagnosticSession'};
const UDS_RESET   = {0x01:'hardReset',0x02:'keyOffOnReset',0x03:'softReset'};
const UDS_DTC_SF  = {
  0x01:'reportNumberOfDTCByStatusMask', 0x02:'reportDTCByStatusMask',
  0x03:'reportDTCSnapshotIdentification', 0x04:'reportDTCSnapshotRecordByDTCNumber',
  0x05:'reportDTCStoredDataByRecordNumber', 0x06:'reportDTCExtDataRecordByDTCNumber',
  0x07:'reportNumberOfDTCBySeverityMaskRecord', 0x08:'reportDTCBySeverityMaskRecord',
  0x09:'reportSeverityInformationOfDTC', 0x0A:'reportSupportedDTC',
  0x0B:'reportFirstTestFailedDTC', 0x0C:'reportFirstConfirmedDTC',
  0x0D:'reportMostRecentTestFailedDTC', 0x0E:'reportMostRecentConfirmedDTC',
  0x0F:'reportMirrorMemoryDTCByStatusMask', 0x14:'reportDTCFaultDetectionCounter',
  0x15:'reportDTCWithPermanentStatus',
};
const UDS_COMM_SF = {0x00:'enableRxAndTx',0x01:'enableRxAndDisableTx',0x02:'disableRxAndEnableTx',0x03:'disableRxAndTx'};
const UDS_IO_CTRL = {0x00:'returnControlToECU',0x01:'resetToDefault',0x02:'freezeCurrentState',0x03:'shortTermAdjustment'};
const UDS_RTN_SF  = {0x01:'startRoutine',0x02:'stopRoutine',0x03:'requestRoutineResults'};
const UDS_DTC_ON  = {0x01:'on',0x02:'off'};
const UDS_LNK_SF  = {0x01:'verifyBaudrateTransitionWithFixedBaudrate',0x02:'verifyBaudrateTransitionWithSpecificBaudrate',0x03:'transitionBaudrate'};
const UDS_PRD_SF  = {0x01:'sendAtSlowRate',0x02:'sendAtMediumRate',0x03:'sendAtFastRate',0x04:'stopSending'};
const UDS_DDDI_SF = {0x01:'defineByIdentifier',0x02:'defineByMemoryAddress',0x03:'clearDynamicallyDefinedDataIdentifier'};

function udsH(v,w=2){ return '0x'+v.toString(16).toUpperCase().padStart(w,'0'); }
function udsBytesHex(b){ return b.map(v=>v.toString(16).toUpperCase().padStart(2,'0')).join(' '); }
function udsDTC(a,b,c){ const p=['P','C','B','U'][(a>>6)&3]; return p+[((a>>4)&3),(a&0xF),(b>>4),(b&0xF),(c>>4),(c&0xF)].map(n=>n.toString(16).toUpperCase()).join('')+'  ('+udsBytesHex([a,b,c])+')'; }
function udsDTCStatus(s){ return ['testFailed','testFailedThisMonitoringCycle','pendingDTC','confirmedDTC','testNotCompletedSinceLastClear','testFailedSinceLastClear','testNotCompletedThisMonitoringCycle','warningIndicatorRequested'].filter((_,i)=>s&(1<<i)).join(', ')||'none'; }
// Deep-link a decoded DTC to the standalone dtc.html decoder.
function dtcLink(label,qs){ return `<a href="explainers/dtc.html?${qs}" target="_blank" style="color:var(--blue);text-decoration:none">${escHtml(label)} ↗</a>`; }
function dtcHexQ(arr){ return arr.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('+'); }
function udsMemAddr(bytes,o){ const alfi=bytes[o],sa=(alfi>>4)&0xF,aa=alfi&0xF; let addr=0,size=0; for(let i=0;i<aa;i++)addr=(addr<<8)|(bytes[o+1+i]||0); for(let i=0;i<sa;i++)size=(size<<8)|(bytes[o+1+aa+i]||0); return {addr,size,consumed:1+aa+sa,adBytes:aa}; }

function udsDecode(bytes){
  if(!bytes||!bytes.length)return null;
  // OBD-II modes 0x01–0x0A (req) and 0x41–0x4A (resp) - check before UDS
  const m=bytes[0];
  if((m>=0x01&&m<=0x0A)||(m>=0x41&&m<=0x4A)){const o=obdDecode(bytes);if(o)return o;}
  if(m===0x7F)return udsDecodeNeg(bytes);
  const sid=m-0x40;
  if((m&0x40)&&UDS_SVC[sid])return udsDecodeRsp(bytes,sid);
  return udsDecodeReq(bytes,m);
}

function udsDecodeNeg(bytes){
  // A well-formed negative response is exactly 3 bytes: 7F <service> <NRC>. Anything shorter is
  // malformed - flag it instead of reading undefined bytes as 0x00 (bogus service/generalReject).
  if(bytes.length<3)return { type:'negative', summary:'NegativeResponse · malformed (truncated)',
    rows:[{k:'Type',v:'Negative Response - malformed (expected 3 bytes: 7F SID NRC)'},{k:'Raw',v:bytes.map(udsH).join(' ')}] };
  const sid=bytes[1],nrc=bytes[2];
  const sNm=UDS_SVC[sid]||udsH(sid),nNm=UDS_NRC[nrc]||udsH(nrc);
  const isPd=nrc===0x78;
  return { type:isPd?'pending':'negative',
    summary:isPd?`ResponsePending · ${sNm}`:`NegativeResponse · ${sNm} · ${nNm}`,
    rows:[{k:'Type',v:isPd?'Response Pending (NRC 0x78)':'Negative Response'},{k:'Service',v:`${udsH(sid)}  ${sNm}`},{k:'NRC',v:`${udsH(nrc)}  ${nNm}`}] };
}

function udsDecodeReq(bytes,sid){
  const sNm=UDS_SVC[sid]||`Unknown ${udsH(sid)}`;
  const rows=[{k:'Service',v:`${udsH(sid)}  ${sNm}`}];
  const add=(k,v)=>rows.push({k,v});
  let summary=sNm;
  const sf=bytes.length>1?bytes[1]:null,sfV=sf!==null?sf&0x7F:null,sfSPR=sf!==null&&!!(sf&0x80);
  switch(sid){
    case 0x10:{const n=UDS_SESSION[sfV]||udsH(sfV);add('Session',`${udsH(sfV)}  ${n}`);if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x11:{const n=UDS_RESET[sfV]||udsH(sfV);add('Reset type',`${udsH(sfV)}  ${n}`);if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x14:{if(bytes.length>=4){const g=(bytes[1]<<16)|(bytes[2]<<8)|bytes[3];add('Group of DTC',g===0xFFFFFF?'0xFFFFFF (all)':udsH(g,6));summary=`${sNm} · ${g===0xFFFFFF?'all':udsH(g,6)}`;}break;}
    case 0x19:{const n=UDS_DTC_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;
      if([0x01,0x02,0x07,0x08,0x0F,0x11,0x12,0x13,0x17].includes(sfV)&&bytes.length>2)add('Status mask',udsH(bytes[2]));
      if([0x04,0x06,0x09,0x10].includes(sfV)&&bytes.length>4){add('DTC',udsDTC(bytes[2],bytes[3],bytes[4]));if(bytes.length>5)add('Record number',udsH(bytes[5]));}
      break;}
    case 0x22:{const dids=[];for(let i=1;i+1<bytes.length;i+=2){const d=(bytes[i]<<8)|bytes[i+1];dids.push(udsH(d,4));add('DID',udsH(d,4));}summary=`${sNm} · ${dids.join(', ')}`;break;}
    case 0x23:{if(bytes.length>=2){const m=udsMemAddr(bytes,1);add('Address',udsH(m.addr,m.adBytes*2));add('Size',`${m.size} bytes`);summary=`${sNm} · addr ${udsH(m.addr,m.adBytes*2)} · ${m.size} B`;}break;}
    case 0x24:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));summary=`${sNm} · ${udsH(d,4)}`;}break;}
    case 0x27:{const lvl=sfV,isR=!!(lvl&1);add('Level',`${udsH(lvl)}  (${isR?'requestSeed':'sendKey'})`);if(!isR&&bytes.length>2)add('Key',udsBytesHex(bytes.slice(2)));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · level ${udsH(lvl)} ${isR?'(request seed)':'(send key)'}`;break;}
    case 0x28:{const n=UDS_COMM_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>2)add('Communication type',udsH(bytes[2]));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x2A:{const n=UDS_PRD_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>2)add('Periodic DIDs',bytes.slice(2).map(b=>udsH(b)).join(', '));summary=`${sNm} · ${n}`;break;}
    case 0x2C:{const n=UDS_DDDI_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>=4)add('Target DID',udsH((bytes[2]<<8)|bytes[3],4));summary=`${sNm} · ${n}`;break;}
    case 0x2E:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));if(bytes.length>3)add('Data',udsBytesHex(bytes.slice(3)));summary=`${sNm} · ${udsH(d,4)} · ${bytes.length-3} byte(s)`;}break;}
    case 0x2F:{if(bytes.length>=4){const d=(bytes[1]<<8)|bytes[2],cn=UDS_IO_CTRL[bytes[3]]||udsH(bytes[3]);add('DID',udsH(d,4));add('Control option',`${udsH(bytes[3])}  ${cn}`);if(bytes.length>4)add('Enable mask',udsBytesHex(bytes.slice(4)));summary=`${sNm} · ${udsH(d,4)} · ${cn}`;}break;}
    case 0x31:{if(bytes.length>=4){const n=UDS_RTN_SF[sfV]||udsH(sfV),rid=(bytes[2]<<8)|bytes[3];add('Sub-function',`${udsH(sfV)}  ${n}`);add('Routine ID',udsH(rid,4));if(bytes.length>4)add('Optional record',udsBytesHex(bytes.slice(4)));summary=`${sNm} · ${n} · ${udsH(rid,4)}`;}break;}
    case 0x34:case 0x35:{if(bytes.length>=2){const dfi=bytes[1];add('Data format',`${udsH(dfi)}  compress=${(dfi>>4)&0xF} encrypt=${dfi&0xF}`);if(bytes.length>2){const m=udsMemAddr(bytes,2);add('Address',udsH(m.addr,m.adBytes*2));add('Size',`${m.size} bytes`);summary=`${sNm} · ${udsH(m.addr,m.adBytes*2)} · ${m.size} B`;}else summary=sNm;}break;}
    case 0x36:{if(bytes.length>=2){add('Block seq counter',udsH(bytes[1]));if(bytes.length>2)add('Data',`${udsBytesHex(bytes.slice(2,18))}${bytes.length>18?'…':''}  (${bytes.length-2} bytes)`);summary=`${sNm} · block ${udsH(bytes[1])} · ${bytes.length-2} B`;}break;}
    case 0x37:{if(bytes.length>1)add('Optional record',udsBytesHex(bytes.slice(1)));summary=sNm;break;}
    case 0x38:{if(bytes.length>=2)add('Mode of operation',udsH(bytes[1]));summary=sNm;break;}
    case 0x3D:{if(bytes.length>=2){const m=udsMemAddr(bytes,1);add('Address',udsH(m.addr,m.adBytes*2));add('Size',`${m.size} bytes`);const ds=1+m.consumed;if(bytes.length>ds)add('Data',udsBytesHex(bytes.slice(ds)));summary=`${sNm} · ${udsH(m.addr,m.adBytes*2)}`;}break;}
    case 0x3E:{const n=sfV===0?'zeroSubFunction':udsH(sfV);add('Sub-function',`${udsH(sf)}  ${n}${sfSPR?' (suppress PR)':''}`);summary=`${sNm}${sfSPR?' (no response)':''}`;break;}
    case 0x83:case 0x86:{if(sf!==null)add('Sub-function',udsH(sfV));summary=sNm;break;}
    case 0x85:{const n=UDS_DTC_ON[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  DTC setting ${n}`);if(bytes.length>=5)add('Group of DTC',udsBytesHex(bytes.slice(2,5)));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x87:{const n=UDS_LNK_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>2)add('Baudrate record',udsBytesHex(bytes.slice(2)));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    default:{if(bytes.length>1)add('Payload',udsBytesHex(bytes.slice(1)));}
  }
  return {type:'request',summary,rows};
}

function udsDecodeRsp(bytes,sid){
  const sNm=UDS_SVC[sid]||`Unknown ${udsH(sid)}`;
  const rows=[{k:'Type',v:'Positive Response'},{k:'Service',v:`${udsH(sid)}  ${sNm}`}];
  const add=(k,v)=>rows.push({k,v});
  let summary=`PositiveResponse · ${sNm}`;
  const sf=bytes.length>1?bytes[1]:null,sfV=sf!==null?sf&0x7F:null;
  switch(sid){
    case 0x10:{const n=UDS_SESSION[sfV]||udsH(sfV);add('Session',`${udsH(sfV)}  ${n}`);if(bytes.length>=6){add('P2 max',`${(bytes[2]<<8)|bytes[3]} ms`);add('P2* max',`${((bytes[4]<<8)|bytes[5])*10} ms`);}summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x11:{const n=UDS_RESET[sfV]||udsH(sfV);add('Reset type',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x14:{summary=`PositiveResponse · ${sNm} · cleared`;break;}
    case 0x19:{const n=UDS_DTC_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;
      if(sfV===0x01&&bytes.length>=6){add('Status avail mask',udsH(bytes[2]));add('DTC format',udsH(bytes[3]));const cnt=(bytes[4]<<8)|bytes[5];add('DTC count',String(cnt));summary+=` · ${cnt} DTC(s)`;}
      else if([0x02,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F,0x13,0x15].includes(sfV)){
        if(bytes.length>=3)add('Status avail mask',udsH(bytes[2]));
        const dtcs=[],dtcHtml=[];let i=3;while(i+3<bytes.length){const a=bytes[i],b=bytes[i+1],c=bytes[i+2],st=bytes[i+3],code=udsDTC(a,b,c);dtcs.push(`${code}  status ${udsH(st)} (${udsDTCStatus(st)})`);dtcHtml.push(`${dtcLink(code,`bytes=${dtcHexQ([a,b,c,st])}&fmt=uds`)}  <span style="color:var(--text2)">status ${udsH(st)} (${escHtml(udsDTCStatus(st))})</span>`);i+=4;}
        if(dtcs.length){rows.push({k:'DTCs',v:dtcs.join('\n'),vHtml:dtcHtml.join('<br>')});summary+=` · ${dtcs.length} DTC(s)`;}else{add('DTCs','none');summary+=' · no DTCs';}
      }
      else if([0x06,0x10].includes(sfV)&&bytes.length>=5){const a=bytes[2],b=bytes[3],c=bytes[4],st=bytes.length>=6?bytes[5]:null,code=udsDTC(a,b,c);rows.push({k:'DTC',v:code,vHtml:dtcLink(code,`bytes=${dtcHexQ(st!==null?[a,b,c,st]:[a,b,c])}&fmt=uds`)});if(bytes.length>=6)add('Status',`${udsH(bytes[5])}  ${udsDTCStatus(bytes[5])}`);if(bytes.length>6)add('Ext data',udsBytesHex(bytes.slice(6)));}
      break;}
    case 0x22:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));const data=bytes.slice(3);if(data.length){add('Data',`${udsBytesHex(data.slice(0,32))}${data.length>32?'…':''}  (${data.length} bytes)`);const asc=data.map(b=>b>=32&&b<127?String.fromCharCode(b):'.').join('');if(asc.replace(/\./g,'').length>=2)add('ASCII',asc);}summary=`PositiveResponse · ${sNm} · ${udsH(d,4)}`;}break;}
    case 0x23:{if(bytes.length>1){const d=bytes.slice(1);add('Data',`${udsBytesHex(d.slice(0,32))}${d.length>32?'…':''}  (${d.length} bytes)`);summary=`PositiveResponse · ${sNm} · ${d.length} bytes`;}break;}
    case 0x27:{const lvl=sfV,isR=!!(lvl&1);add('Level',`${udsH(lvl)}  (${isR?'seed':'key accepted'})`);if(isR&&bytes.length>2)add('Seed',udsBytesHex(bytes.slice(2)));summary=`PositiveResponse · ${sNm} · ${isR?'seed':'key accepted'}`;break;}
    case 0x28:{const n=UDS_COMM_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x2C:{const n=UDS_DDDI_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>=4)add('DID',udsH((bytes[2]<<8)|bytes[3],4));summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x2E:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));summary=`PositiveResponse · ${sNm} · ${udsH(d,4)}`;}break;}
    case 0x2F:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));if(bytes.length>3)add('Control status',udsBytesHex(bytes.slice(3)));summary=`PositiveResponse · ${sNm} · ${udsH(d,4)}`;}break;}
    case 0x31:{if(bytes.length>=4){const n=UDS_RTN_SF[sfV]||udsH(sfV),rid=(bytes[2]<<8)|bytes[3];add('Sub-function',`${udsH(sfV)}  ${n}`);add('Routine ID',udsH(rid,4));if(bytes.length>4)add('Status record',udsBytesHex(bytes.slice(4)));summary=`PositiveResponse · ${sNm} · ${n} · ${udsH(rid,4)}`;}break;}
    case 0x34:case 0x35:{if(bytes.length>=2){const lfi=bytes[1],nb=(lfi>>4)&0xF;let sz=0;for(let i=0;i<nb;i++)sz=(sz<<8)|(bytes[2+i]||0);add('Max block length',`${sz} bytes`);summary=`PositiveResponse · ${sNm} · maxBlock ${sz} B`;}break;}
    case 0x36:{if(bytes.length>=2){add('Block seq counter',udsH(bytes[1]));if(bytes.length>2)add('Response param',udsBytesHex(bytes.slice(2)));summary=`PositiveResponse · ${sNm} · block ${udsH(bytes[1])}`;}break;}
    case 0x37:{if(bytes.length>1)add('Transfer response',udsBytesHex(bytes.slice(1)));summary=`PositiveResponse · ${sNm}`;break;}
    case 0x3E:{summary=`PositiveResponse · ${sNm}`;break;}
    case 0x85:{const n=UDS_DTC_ON[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  DTC setting ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x87:{const n=UDS_LNK_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    default:{if(bytes.length>1)add('Payload',udsBytesHex(bytes.slice(1)));}
  }
  return {type:'positive',summary,rows};
}

// ── KWP2000 (ISO 14230) - UDS's ancestor on the same ISO-TP carrier ──
// Separate tables (NOT a patch to UDS_*): several SIDs collide with UDS but mean
// different things - 0x21 ReadDataByLocalIdentifier, 0x1A ReadECUIdentification,
// 0x81 StartCommunication. Positive-response (SID+0x40) and 0x7F neg-response
// conventions are identical to UDS, so kwpDecode mirrors udsDecode's shape.
const KWP_SVC = {
  0x10:'StartDiagnosticSession', 0x11:'ECUReset',
  0x14:'ClearDiagnosticInformation', 0x17:'ReadStatusOfDTC',
  0x18:'ReadDTCByStatus', 0x1A:'ReadECUIdentification',
  0x20:'StopDiagnosticSession', 0x21:'ReadDataByLocalIdentifier',
  0x22:'ReadDataByCommonIdentifier', 0x23:'ReadMemoryByAddress',
  0x27:'SecurityAccess', 0x28:'DisableNormalMessageTransmission',
  0x29:'EnableNormalMessageTransmission', 0x2C:'DynamicallyDefineLocalIdentifier',
  0x2E:'WriteDataByCommonIdentifier', 0x2F:'InputOutputControlByCommonIdentifier',
  0x30:'InputOutputControlByLocalIdentifier', 0x31:'StartRoutineByLocalIdentifier',
  0x32:'StopRoutineByLocalIdentifier', 0x33:'RequestRoutineResultsByLocalIdentifier',
  0x34:'RequestDownload', 0x35:'RequestUpload', 0x36:'TransferData',
  0x37:'RequestTransferExit', 0x38:'StartRoutineByAddress',
  0x39:'StopRoutineByAddress', 0x3A:'RequestRoutineResultsByAddress',
  0x3B:'WriteDataByLocalIdentifier', 0x3D:'WriteMemoryByAddress',
  0x3E:'TesterPresent', 0x81:'StartCommunication', 0x82:'StopCommunication',
  0x83:'AccessTimingParameters', 0x85:'StartProgrammingSession',
};
const KWP_NRC = {
  0x10:'generalReject', 0x11:'serviceNotSupported', 0x12:'subFunctionNotSupported',
  0x21:'busyRepeatRequest', 0x22:'conditionsNotCorrect', 0x23:'routineNotComplete',
  0x31:'requestOutOfRange', 0x33:'securityAccessDenied', 0x35:'invalidKey',
  0x36:'exceedNumberOfAttempts', 0x37:'requiredTimeDelayNotExpired',
  0x40:'downloadNotAccepted', 0x41:'improperDownloadType',
  0x42:'cantDownloadToSpecifiedAddress', 0x43:'cantDownloadNumberOfBytesRequested',
  0x50:'uploadNotAccepted', 0x51:'improperUploadType', 0x71:'transferSuspended',
  0x72:'transferAborted', 0x74:'illegalAddressInBlockTransfer',
  0x75:'illegalByteCountInBlockTransfer', 0x76:'illegalBlockTransferType',
  0x77:'blockTransferDataChecksumError',
  0x78:'requestCorrectlyReceivedResponsePending',
  0x79:'incorrectByteCountDuringBlockTransfer',
  0x80:'serviceNotSupportedInActiveDiagnosticSession',
  0x9A:'dataDecompressionFailed', 0x9B:'dataDecryptionFailed',
  0xA0:'ecuNotResponding', 0xA1:'ecuAddressUnknown',
};
const KWP_DIAG_MODE = {0x81:'default',0x85:'programming',0x89:'standby',0x92:'EOL/end-of-line'};

// ASCII render with hex fallback (mirrors udsDecodeRsp 0x22 / obdDecode VIN guard).
function kwpAscii(b){ const a=b.map(v=>v>=32&&v<127?String.fromCharCode(v):'.').join(''); return a.replace(/\./g,'').length>=2?a:null; }

function kwpDecode(bytes){
  if(!bytes||!bytes.length)return null;
  const m=bytes[0];
  if(m===0x7F){
    if(bytes.length<3)return { type:'negative', summary:'NegativeResponse · malformed (truncated)',
      rows:[{k:'Type',v:'Negative Response - malformed (expected 3 bytes: 7F SID NRC)'},{k:'Raw',v:bytes.map(udsH).join(' ')}] };
    const sid=bytes[1],nrc=bytes[2];
    const sNm=KWP_SVC[sid]||udsH(sid),nNm=KWP_NRC[nrc]||udsH(nrc);
    const isPd=nrc===0x78;
    return { type:isPd?'pending':'negative',
      summary:isPd?`ResponsePending · ${sNm}`:`NegativeResponse · ${sNm} · ${nNm}`,
      rows:[{k:'Type',v:isPd?'Response Pending (NRC 0x78)':'Negative Response'},{k:'Service',v:`${udsH(sid)}  ${sNm}`},{k:'NRC',v:`${udsH(nrc)}  ${nNm}`}] };
  }
  const isRsp=!!(m&0x40)&&!!KWP_SVC[m-0x40];
  const sid=isRsp?m-0x40:m;
  const sNm=KWP_SVC[sid]||`Unknown ${udsH(sid)}`;
  const rows=[]; if(isRsp)rows.push({k:'Type',v:'Positive Response'}); rows.push({k:'Service',v:`${udsH(sid)}  ${sNm}`});
  const add=(k,v)=>rows.push({k,v});
  let summary=isRsp?`PositiveResponse · ${sNm}`:sNm;
  const body=bytes.slice(1);
  switch(sid){
    case 0x10:{const dm=bytes[1];if(dm!==undefined){const n=KWP_DIAG_MODE[dm]||udsH(dm);add('Diagnostic mode',`${udsH(dm)}  ${n}`);summary+=` · ${n}`;}break;}
    case 0x21:{const rli=bytes[1];if(rli!==undefined){add('Local identifier',udsH(rli));summary+=` · RLI ${udsH(rli)}`;}
      if(isRsp&&bytes.length>2){const data=bytes.slice(2);add('Data',`${udsBytesHex(data.slice(0,32))}${data.length>32?'…':''}  (${data.length} bytes)`);const a=kwpAscii(data);if(a)add('ASCII',a);}break;}
    case 0x1A:{const opt=bytes[1];if(opt!==undefined){add('Identification option',udsH(opt));summary+=` · ${udsH(opt)}`;}
      if(isRsp&&bytes.length>2){const data=bytes.slice(2);const a=kwpAscii(data);if(a)add('Identification',a);add('Data',`${udsBytesHex(data.slice(0,32))}${data.length>32?'…':''}  (${data.length} bytes)`);}break;}
    case 0x81:case 0x83:{if(body.length)add(isRsp?'Response params':'Params',udsBytesHex(body));break;}
    default:{if(body.length)add('Payload',udsBytesHex(body));}
  }
  return {type:isRsp?'positive':'request',summary,rows};
}

// Decode dispatcher - KWP mode uses the KWP tables; UDS/OBD stay in udsDecode
// (its existing OBD-mode auto-sniff is unchanged).
function decodePayload(bytes){ return obdProtoMode === 'kwp' ? kwpDecode(bytes) : udsDecode(bytes); }

/** Generate expandable decode HTML. id must be unique per call. */
function udsSection(decoded, id) {
  if (!decoded) return '';
  const {type,summary,rows} = decoded;
  const color = {request:'var(--text2)',positive:'var(--green)',negative:'var(--red)',pending:'var(--amber)'}[type]||'var(--text2)';
  const rowsHtml = rows.map(r => {
    const val = r.vHtml || escHtml(String(r.v)).replace(/\n/g,'<br>');
    return `<div style="display:flex;gap:8px;padding:1px 0;flex-wrap:wrap">` +
      `<span style="min-width:130px;flex-shrink:0;color:var(--text3);font-family:var(--sans);font-size:10px;text-transform:uppercase;letter-spacing:0.05em">${escHtml(r.k)}</span>` +
      `<span style="color:var(--text);font-size:11px;font-family:var(--mono);word-break:break-all">${val}</span>` +
    `</div>`;
  }).join('');
  return `<div style="margin-top:3px">` +
    `<div onclick="udsToggle('${id}')" style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;user-select:none">` +
      `<span id="${id}_a" style="color:${color};font-size:9px;line-height:1">▶</span>` +
      `<span style="color:${color};font-family:var(--sans);font-size:11px">${escHtml(summary)}</span>` +
    `</div>` +
    `<div id="${id}_d" style="display:none;margin-top:5px;padding:6px 10px;background:var(--bg2);border-left:2px solid var(--border2);border-radius:0 4px 4px 0">${rowsHtml}</div>` +
  `</div>`;
}
function udsToggle(id) {
  const d=document.getElementById(id+'_d'),a=document.getElementById(id+'_a');
  if(!d||!a)return;
  const open=d.style.display!=='none';
  d.style.display=open?'none':'block';
  a.textContent=open?'▶':'▼';
}

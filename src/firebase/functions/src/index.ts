import * as functions from 'firebase-functions';
import { SkipListStore } from '../../../assets/ts/datastore';
import { FirebaseBackend } from '../../../assets/ts/data_backend';
import { ClientSuffixArray } from '../../../assets/ts/suffixarray'

const backend = new FirebaseBackend('', '', '', true);
const suffixArray = new ClientSuffixArray(new SkipListStore(backend));

export const checkImplemented = functions.region('us-central1').https.onCall(async (_data, _context) => {
  console.log('check called');
  return { implemented: true };
});

export const insertRecord = functions.https.onCall(async (data, _context) => {
  const record = data.record;
  await suffixArray.insertRecord(record);
  return { completed: true };
});

export const deleteRecord = functions.https.onCall(async (data, _context) => {
  const record = data.record;
  await suffixArray.deleteRecord(record);
  return { completed: true };
});

export const query = functions.https.onCall(async (data, _context) => {
  const pattern = data.pattern, num_results = data.num_results;
  const results = await suffixArray.query(pattern, num_results);
  return { results: results };
});

export const getLastRow = functions.https.onCall(async (_data, _context) => {
  const lastRow = await suffixArray.getLastRow();
  return { lastRow: lastRow };
});

export const setLastRow = functions.https.onCall(async (data, _context) => {
  const row = data.row;
  await suffixArray.setLastRow(row);
  return { completed: true };
});
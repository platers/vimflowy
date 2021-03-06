import * as _ from 'lodash';
// import 'core-js/shim';

import { SearchStore } from './datastore';
import { all } from './plugins';
import {
  Row, Chars 
} from './types';

// remove punctuation https://stackoverflow.com/questions/4328500/how-can-i-strip-all-punctuation-from-a-string-in-javascript-using-regex
const punctRE = /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,\-.\/:;<=>?@\[\]^_`{|}~]/g;
const spaceRE = /\s+/g;

export class Searcher {
    public searchStore: SearchStore;
    private maxRowsStored: number;
    private startText: {[row: number]: string};
    private endText: {[row: number]: string};

    constructor(searchStore: SearchStore) {
        this.searchStore = searchStore;
        this.maxRowsStored = 20000;
        this.startText = {};
        this.endText = {};
    }

    public rowChange(row: Row, oldText: string, newText: string) {
        if (!(row in this.startText)) {
            this.startText[row] = oldText;
        }
        this.endText[row] = newText;
    }

    public async update(row: Row) {
        if (!(row in this.startText) || !(row in this.endText)) {
            return;
        }
        // only updates changed words
        const oldText = this.startText[row].replace(punctRE, '').replace(spaceRE, ' ');
        const newText = this.endText[row].replace(punctRE, '').replace(spaceRE, ' ');

        delete this.startText[row];
        delete this.endText[row];

        const oldTokens = oldText.toLowerCase().split(' ');
        const newTokens = newText.toLowerCase().split(' ');

        const getPrefixs = (token: string) => {
            return _.range(token.length).map((idx) => token.slice(0, idx + 1));
        };
        const oldPrefixs = _.flatMap(oldTokens, (token) => getPrefixs(token));
        const newPrefixes = _.flatMap(newTokens, (token) => getPrefixs(token));
        const oldSet = new Set(oldPrefixs);
        const newSet = new Set(newPrefixes);
        await Promise.all(oldPrefixs.map(async (token) => {
            // remove deleted tokens
            if (!newSet.has(token)) {
                const rows = await this.searchStore.getRows(token);
                rows.delete(row);
                return this.searchStore.setRows(token, rows);
            }
        }));
        return Promise.all(newPrefixes.map(async (token) => {
            // add new tokens
            if (!oldSet.has(token)) {
                const rows = await this.searchStore.getRows(token);
                if (rows.size < this.maxRowsStored) {
                    rows.add(row);
                }
                return this.searchStore.setRows(token, rows);
            }
        }));
    }

    // returns a list of rows which could match the query. Returns null if too many results
    public async search(queries: string[]): Promise<Set<Row> | null> {
        if (queries.length === 0) {
            return new Set();
        }
        let allRows = await Promise.all(queries.map(async (token) => {
            token = token.replace(punctRE, '').replace(spaceRE, '');
            return this.searchStore.getRows(token);
        }));

        if (queries.length === 1) {
            return allRows[0];
        }

        allRows = allRows.filter((rows) => (rows.size < this.maxRowsStored));
        if (allRows.length === 0) {
            return null;
        }
        return allRows.reduce((a, b) => new Set(Array.from(a).filter(x => b.has(x))));
    }
}
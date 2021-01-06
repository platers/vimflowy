import * as _ from 'lodash';
// import 'core-js/shim';

import * as errors from '../../shared/utils/errors';
import EventEmitter from './utils/eventEmitter';
import * as fn_utils from './utils/functional';
// import logger from './utils/logger';
import { isWhitespace } from './utils/text';
import Path from './path';
import { SkipListStore } from './datastore';
import { InMemory } from '../../shared/data_backend';
import {
  Row, Col, Char, Line, SerializedLine, SerializedBlock, SkipListNodeId
} from './types';

const headNodeId = -1, tailNodeId = -2;

export class Key {
    public char : Char;
    public id : Row;
    public col : number;
    public next : SkipListNodeId | null; // id of skiplistnode storing the next suffix. null if end of record
    constructor (char : Char, id : Row, col : number, next : SkipListNodeId | null) {
        this.char = char;
        this.id = id;
        this.col = col;
        this.next = next;
    }
}

export class SkipListNode {
    public forward : SkipListNodeId[];
    public key : Key;
    public id : number; //-1 reserved for head, -2 for tail

    constructor (id : number, key : Key) {
        this.key = key;
        this.forward = new Array();
        this.id = id;
    }
}

export class SkipList {
    private store: SkipListStore;
    private p : number;
    private maxLevel : number;
    private size : number;

    constructor (store : SkipListStore, p : number = 0.5, maxLevel : number = 10) {
        this.store = store;
        this.size = 0;
        this.p = p;
        this.maxLevel = maxLevel;
    }

    private isHead = (x: SkipListNode | Key) => {
        if (x instanceof SkipListNode) {
            return x.key.id === headNodeId;
        } else {
            return x.id === headNodeId;
        }
    }

    private isNil = (x: SkipListNode | Key) => {
        if ('key' in x) {
            return x.key.id == tailNodeId;
        } else {
            return x.id == tailNodeId;
        }
    }

    private compareKey = async (a : Key, b : Key) : Promise<boolean> => {
        // return a < b
        if (this.isHead(b)) return false; //null when b is head
        if (this.isHead(a)) return true;
        if (this.isNil(a)) return false;
        if (this.isNil(b)) return true;

        if (a.next == null && b.next == null) return a.id < b.id; // sort by id for delete
        if (a.next == null) return false; // end of key
        if (b.next == null) return true; // end of key

        if (a.char != b.char) return a.char < b.char;
        return await this.compareKey((await this.getNode(a.next))!.key, (await this.getNode(b.next))!.key);
    }
    private sameKey = (a : Key, b : Key) => {
        return a.id === b.id && a.col === b.col;
    }
    public getNode = (id : SkipListNodeId) => {
        return this.store.getNode(id);
    }

    public getNodeFromKey = async (key : Key) => {
        let x = await this.getHeadNode();
        for (let i = this.maxLevel - 1; i >= 0; i--) {
            let next = (await this.getNode(x.forward[i]))!;
            while (!this.isNil(next) && await this.compareKey(next.key, key)) {
                x = next;
                next = (await this.getNode(x.forward[i]))!;
            }
        }
        x = (await this.getNode(x.forward[0]))!;
        if (!this.isNil(x) && this.sameKey(x.key, key)) {
            return x;
        } else {
            console.log(x, x.key, key);
            return null;
        }
    }

    private newNode = async (key : Key, id? : SkipListNodeId) => {
        if (id == null) {
            id = await this.store.getId();
        }
        const node = new SkipListNode(id, key);
        await this.store.setNode(node);
        return node;
    }

    private getHeadNode = async () => {
        let result = await this.store.getNode(headNodeId);
        if (result) {
            return result;
        } else {
            const tail = await this.getTailNode();
            result = await this.newNode(new Key('', -1, -1, null), headNodeId);
            for (let i = 0; i < this.maxLevel; i++) {
                result.forward.push(tail.id);
            }
            await this.store.setNode(result);
            return result;
        }
    }

    private getTailNode = async () => {
        const result = await this.store.getNode(tailNodeId);
        if (result) {
            return result;
        } else {
            return await this.newNode(new Key('', tailNodeId, -2, null), tailNodeId);
        }
    }

    private randomLevel = () => {
        let lvl = 1;
        while (Math.random() < this.p && lvl < this.maxLevel) {
            lvl++;
        }
        return lvl;
    }

    private lowerBound = async (key : Key) => {
        let update : SkipListNode[] = new Array(this.maxLevel);
        let x = await this.getHeadNode();
        for (let i = this.maxLevel - 1; i >= 0; i--) {
            let next = (await this.getNode(x.forward[i]))!;
            while (!this.isNil(next) && await this.compareKey(next.key, key)) {
                x = next;
                next = (await this.getNode(x.forward[i]))!;
            }
            update[i] = x;
        }
        x = (await this.getNode(x.forward[0]))!;
        return {x, update};
    }

    public insert = async (key : Key) => {
        let {x, update} = await this.lowerBound(key);
        if (!this.isNil(x) && this.sameKey(x.key, key)) {
            //overwrite existing?
            console.log('Did not insert key since it already exists');
        } else {
            const lvl = this.randomLevel();
            x = await this.newNode(key);
            for (let i = 0; i < lvl; i++) {
                x.forward.push(update[i].forward[i]);
                await this.store.setNode(x);
                update[i].forward[i] = x.id;
                await this.store.setNode(update[i]);
            }
            this.size++;
        }
        return x;
    }

    public delete = async (key : Key) => {
        let {x, update} = await this.lowerBound(key);
        if (!this.isNil(x) && this.sameKey(x.key, key)) {
            for (let i = 0; i < x.forward.length; i++) {
                if (update[i].forward[i] != x.id) {
                    break;
                } else {
                    update[i].forward[i] = x.forward[i];
                    await this.store.setNode(update[i]);
                }
            }
            this.size--;
        } else {
            console.log('Failed to delete key not in suffix array', key, x.key);
        }
    }

    private compareKeyString = async (a : Key, b : string) : Promise<boolean> => {
        // return a < b
        if (b.length == 0) return false; // end of pattern
        if (this.isHead(a)) return true;
        if (this.isNil(a)) return false;

        if (a.next == null) return false; // end of key

        if (a.char != b[0]) return a.char < b[0];
        return await this.compareKeyString((await this.getNode(a.next))!.key, b.slice(1));
    }

    public length = () => {
        return this.size;
    }

    // Get up to num_results unique ids that might match query
    public getNextKeys = async (query : string, num_results : number) => {
        let x = await this.getHeadNode();
        for (let i = this.maxLevel - 1; i >= 0; i--) {
            let next = (await this.getNode(x.forward[i]))!;
            while (!this.isNil(next) && await this.compareKeyString(next.key, query)) {
                x = next;
                next = (await this.getNode(x.forward[i]))!;
            }
        }
        x = (await this.getNode(x.forward[0]))!;
        const ids = new Set();
        const results = [];
        while (!this.isNil(x) && ids.size < num_results) {
            if (!ids.has(x.key.id)) {
                ids.add(x.key.id);
                results.push(x.key);
            }
            x = (await this.getNode(x.forward[0]))!;
        }
        return results;
    }
}
export class Record {
    public id : Row;
    public text : string;
    constructor (id : number, text : string) {
        this.id = id;
        this.text = text;
    }
}

export class SuffixArray {
    private skiplist : SkipList;
    public store: SkipListStore;

    constructor (store: SkipListStore) {
        this.store = store;
        this.skiplist = new SkipList(this.store, 0.5, 30);
    }

    private getEndOfRecordKey = (id : Row) => {
        return new Key('', id, -1, null);
    }

    public insertRecord = async (record : Record) => {
        record.text = record.text.toLowerCase();
        //console.log('inserting', record.text);
        let lastNode = await this.skiplist.insert(this.getEndOfRecordKey(record.id));
        for (let i = record.text.length - 1; i >= 0; i--) {
            const key = new Key(record.text[i], record.id, i, lastNode.id);
            lastNode = await this.skiplist.insert(key);
        }
    }

    public deleteRecord = async (record : Record) => {
        record.text = record.text.toLowerCase();
        console.log('deleting', record.text);
        const keys = [await this.getEndOfRecordKey(record.id)];
        // keys are in reverse order
        for (let i = record.text.length - 1; i >= 0; i--) {
            const node = await this.skiplist.getNodeFromKey(keys[keys.length - 1]);
            if (node == null) {
                console.log('Could not find record to delete', i, keys[keys.length - 1]);
                return;
            }
            const key = new Key(record.text[i], record.id, i, node.id);
            keys.push(key);
        }
        // must delete nodes front to back
        for (let i = keys.length - 1; i >= 0; i--) {
            this.skiplist.delete(keys[i]);
        }
    }

    private match = async (pattern : string, key : Key) : Promise<boolean> => {
        if (pattern.length == 0) return true;
        if (key.next == null) return false; // key is end of record
        if (pattern[0] != key.char) return false;
        return await this.match(pattern.slice(1), (await this.skiplist.getNode(key.next))!.key);
    }

    public query = async (pattern : string, num_results : number) => {
        pattern = pattern.toLowerCase();
        const keys = await this.skiplist.getNextKeys(pattern, num_results);
        const results = [];
        for (const key of keys) {
            if (await this.match(pattern, key)) {
                results.push(key.id);
            } else { // matching suffixes are consecutive
                break;
            }
        }
        return results;
    }

    public length = () => {
        return this.skiplist.length();
    }
}
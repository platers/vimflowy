import * as _ from 'lodash';
// import 'core-js/shim';

import * as errors from '../../shared/utils/errors';
import EventEmitter from './utils/eventEmitter';
import * as fn_utils from './utils/functional';
// import logger from './utils/logger';
import { isWhitespace } from './utils/text';
import Path from './path';
import { DocumentStore } from './datastore';
import { InMemory } from '../../shared/data_backend';
import {
  Row, Col, Char, Line, SerializedLine, SerializedBlock
} from './types';

type Id = Row;
type Value = null;

class SkipListNode {
    public forward : SkipListNode[];
    public width : number[];
    public key : Key | null;
    public value : Value;
    private nil : boolean;

    constructor (levels : number, key : Key | null, value : Value, nil : boolean = false) {
        this.key = key;
        this.value = value;
        this.nil = nil;
        this.forward = new Array(levels);
        this.width = new Array(levels);
    }

    public isNil = () => {
        return this.nil;
    }
}

class SkipList {
    private p : number;
    private maxLevel : number;
    private head : SkipListNode;
    private tail : SkipListNode;
    private size : number;
    private compareKey : (a : Key | null, b : Key | null) => boolean;
    private sameKey : (a : Key | null, b : Key | null) => boolean;
    //private level : number;

    constructor (p : number = 0.5, maxLevel : number = 10) {
        this.size = 0;
        this.p = p;
        this.maxLevel = maxLevel;
        this.tail = new SkipListNode(this.maxLevel, null, null, true);
        this.head = new SkipListNode(this.maxLevel, null, null);
        this.compareKey = (a : Key | null, b : Key | null) => {
            if (b == null) return false; //null when b is head
            if (a == null) return true;
            if (!a.next && a.id == null) return true; // end of search pattern
            if (!b.next && b.id == null) return false; // end of search pattern
            if (!a.next && !b.next) return a.id < b.id; // sort by id for delete
            if (!a.next) return false; // end of key
            if (!b.next) return true;
            if (a.char != b.char) return a.char! < b.char!;
            return this.compareKey(a.next, b.next);
        }
        this.sameKey = (a : Key | null, b : Key | null) => {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return a.id === b.id && a.col === b.col;
        }
        for (let i = 0; i < this.maxLevel; i++) {
            this.head.forward[i] = this.tail;
            this.head.width[i] = 1;
        }
    }

    private randomLevel = () => {
        let lvl = 1;
        while (Math.random() < this.p && lvl < this.maxLevel) {
            lvl++;
        }
        return lvl;
    }

    public insert = (key : Key, value : Value = null) => {
        let update : SkipListNode[] = new Array(this.maxLevel);
        let x = this.head;
        for (let i = this.maxLevel - 1; i >= 0; i--) {
            while (!x.forward[i].isNil() && this.compareKey(x.forward[i].key, key)) {
                x = x.forward[i];
            }
            update[i] = x;
        }
        x = x.forward[0];
        if (!x.isNil && this.sameKey(x.key, key)) {
            x.value = value;
        } else {
            const lvl = this.randomLevel();
            x = new SkipListNode(this.maxLevel, key, value);
            for (let i = 0; i < lvl; i++) {
                x.forward[i] = update[i].forward[i];
                update[i].forward[i] = x;
            }
            this.size++;
        }
    }

    public delete = (key : Key) => {
        let update : SkipListNode[] = new Array(this.maxLevel);
        let x = this.head;
        for (let i = this.maxLevel - 1; i >= 0; i--) {
            while (!x.forward[i].isNil() && this.compareKey(x.forward[i].key, key)) {
                x = x.forward[i];
            }
            update[i] = x;
        }
        x = x.forward[0];
        if (!x.isNil() && this.sameKey(x.key, key)) {
            for (let i = 0; i < this.maxLevel; i++) {
                if (update[i].forward[i] != x) {
                    break;
                } else {
                    update[i].forward[i] = x.forward[i];
                }
            }
            this.size--;
        } else {
            console.log('Failed to delete key not in suffix array', key, x.key);
        }
    }

    private getNodeBefore = (key : Key) => {
        let x = this.head;
        for (let i = this.maxLevel - 1; i >= 0; i--) {
            while (!x.forward[i].isNil() && this.compareKey(x.forward[i].key, key)) {
                x = x.forward[i];
            }
        }
        return x;
    }

    public getValue = (key : Key) => {
        let x = this.getNodeBefore(key);
        x = x.forward[0];
        if (this.sameKey(x.key, key)) {
            return x.value;
        } else {
            return null;
        }
    }

    public length = () => {
        return this.size;
    }

    // Get up to num_results unique ids that might match key
    public getNextKeys = (key : Key, num_results : number) => {
        let x = this.getNodeBefore(key);
        x = x.forward[0];
        const ids = new Set();
        const results = [];
        while (!x.isNil() && ids.size < num_results) {
            if (!ids.has(x.key!.id)) {
                ids.add(x.key!);
                results.push(x.key!);
            }
            x = x.forward[0];
        }
        return results;
    }
}

class Key {
    public char : Char | null;
    public id : Id;
    public col : number | null;
    public next : Key | null; //null if end of record
    constructor (char : Char | null, id : Id, col : number | null, next : Key | null) {
        this.char = char;
        this.id = id;
        this.col = col;
        this.next = next;
    } 
}

export class Record {
    public id : Id | null;
    public text : string;
    constructor (id : number | null, text : string) {
        this.id = id;
        this.text = text.toLocaleLowerCase();
    }
}

export default class SuffixArray {
    private skiplist : SkipList;
    
    constructor () {
        this.skiplist = new SkipList(0.5, 30);
    }
    
    private getEndOfRecordKey = (id : Id) => {
        return new Key(null, id, null, null);
    }

    private applyToRecord = (record : Record, f : (key : Key) => void) => {
        let lastKey = this.getEndOfRecordKey(record.id!);
        f(lastKey);
        for (let i = record.text.length - 1; i >= 0; i--) {
            const key = new Key(record.text[i], record.id!, i, lastKey);
            f(key);
            lastKey = key;
        }
        return lastKey;
    }

    public insertRecord = async (record : Record) => {
        this.applyToRecord(record, this.skiplist.insert);
        console.log('insertRecord');
    }

    public deleteRecord = async (record : Record) => {
        this.applyToRecord(record, this.skiplist.delete);
    }

    private match = (pattern : Key, key : Key) : boolean => {
        if (!pattern.next) return true;
        if (!key.next) return false;
        if (pattern.char != key.char) return false;
        return this.match(pattern.next, key.next);
    }

    public query = async (pattern : string, num_results : number) => {
        const record = new Record(null, pattern);
        const patternKey = this.applyToRecord(record, () => {});
        const keys = this.skiplist.getNextKeys(patternKey, num_results);
        const results = [];
        for (const key of keys) {
            if (this.match(patternKey, key)) {
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
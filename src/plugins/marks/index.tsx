import * as _ from 'lodash';
import * as React from 'react'; // tslint:disable-line no-unused-variable

import * as errors from '../../shared/utils/errors';
import { Logger } from '../../shared/utils/logger';
import { PartialUnfolder, Token, EmitFn, Tokenizer } from '../../assets/ts/utils/token_unfolder';

import { registerPlugin, PluginApi } from '../../assets/ts/plugins';
import Menu from '../../assets/ts/menu';
import Document from '../../assets/ts/document';
import Session, { InMemorySession } from '../../assets/ts/session';
import LineComponent from '../../assets/ts/components/line';
import Mutation from '../../assets/ts/mutations';
import Path from '../../assets/ts/path';
import { Col, Row, SerializedBlock } from '../../assets/ts/types';
import { getStyles } from '../../assets/ts/themes';

import { SINGLE_LINE_MOTIONS } from '../../assets/ts/definitions/motions';
import { INSERT_MODE_MAPPINGS, INSERT_MOTION_MAPPINGS } from '../../assets/ts/configurations/vim';
import { ActionContext, ActionName, motionKey } from '../../assets/ts/keyDefinitions';
import { ChangeChars } from '../../assets/ts/mutations';
import { nonSavingInsertActions, transform_insert_key } from '../../assets/ts/modes';

// TODO: do this elsewhere
declare const process: any;

type Mark = string;
type MarksToRows = {[key: string]: Row};
type RowsToMarks = {[key: number]: Mark};

const markStyle = {
  padding: '0px 8px',
  marginRight: 8,
  borderRadius: 5,
};

/*
 * ALGORITHMIC NOTE: maintaining the set of marks
 * Rather than trying to update the list
 * as rows get removed and added from the document (which is especially
 * tricky because of cloning),
 * we simply store all marks, even if attached to the document,
 * and then prune after looking them up.
 */

export class MarksPlugin {
  private api: PluginApi;
  private logger: Logger;
  private session: Session;
  private document: Document;
  private markstate: {
    session: Session,
    path: Path,
  } | null = null;
  // hacky, these are only used when enabled
  public SetMark!: new(row: Row, mark: Mark) => Mutation;
  public UnsetMark!: new(row: Row) => Mutation;
  private marks_to_paths: {[mark: string]: Path};
  private autocomplete_state: {
    idx: number,
    matches: string[],
  } = { idx: 0, matches: [] }

  constructor(api: PluginApi) {
    this.api = api;
    this.logger = this.api.logger;
    this.session = this.api.session;
    this.document = this.session.document;
    // NOTE: this may not be initialized correctly at first
    // this only affects rendering @marklinks for now
    this.marks_to_paths = {};
  }

  public async enable() {
    const that = this;
    this.logger.debug('Enabling marks');

    class SetMark extends Mutation {
      private row: Row;
      private mark: Mark;

      constructor(row: Row, mark: Mark) {
        super();
        this.row = row;
        this.mark = mark;
      }
      public str() {
        return `row ${this.row}, mark ${this.mark}`;
      }
      public async mutate(/* session */) {
        await that._setMark(this.row, this.mark);
        await that.api.updatedDataForRender(this.row);
      }
      public async rewind(/* session */) {
        return [
          new UnsetMark(this.row),
        ];
      }
    }
    this.SetMark = SetMark;

    class UnsetMark extends Mutation {
      private row: Row;
      private mark: Mark | null | undefined = undefined;

      constructor(row: Row) {
        super();
        this.row = row;
      }
      public str() {
        return `row ${this.row}`;
      }
      public async mutate(/* session */) {
        this.mark = await that.getMark(this.row);
        if (this.mark !== null) {
          await that._unsetMark(this.row, this.mark);
          await that.api.updatedDataForRender(this.row);
        }
      }
      public async rewind(/* session */) {
        if (this.mark === undefined) {
          throw new Error('Rewinding before mutating: UnsetMark');
        }
        if (this.mark === null) {
          return [];
        }
        return [
          new SetMark(this.row, this.mark),
        ];
      }
    }
    this.UnsetMark = UnsetMark;

    // Serialization #

    this.api.registerHook('document', 'serializeRow', async (struct, info) => {
      const mark = await this.getMark(info.row);
      if (mark) {
        struct.mark = mark;
      }
      return struct;
    });

    this.api.registerListener('document', 'loadRow', async (path, serialized) => {
      if (serialized.mark != null) {
        const err = await this.setMark(path.row, serialized.mark);
        if (err) { return this.session.showMessage(err, {text_class: 'error'}); }
      }
    });

    // Commands #

    this.markstate = null;

    this.api.registerMode({
      name: 'MARK',
      cursorBetween: true,
      within_row: true,
      enter: async (session /*, newMode?: ModeId */) => {
        // initialize marks stuff
        this.markstate = {
          session: new InMemorySession(),
          path: session.cursor.path,
        };
        await this.markstate.session.setMode('INSERT');
      },
      exit: async (/*session, newMode?: ModeId */) => {
        // do this, now that markstate is cleared
        if (!this.markstate) {
          throw new Error('Mark state null during exit');
        }
        const markedRow = this.markstate.path.row;
        this.markstate = null;
        await this.api.updatedDataForRender(markedRow);
      },
      every: async (/*session*/) => {
        if (!this.markstate) {
          throw new Error('Mark state null during every');
        }
        await this.api.updatedDataForRender(this.markstate.path.row);
      },
      key_transforms: [
        async (key, context) => {
          if (key === 'space') { key = ' '; };
          if (key.length === 1) {
            if (this.markstate === null) {
              throw new Error('Mark state null during key transform');
            }
            await this.markstate.session.addCharsAtCursor([key]);
            await this.api.updatedDataForRender(this.markstate.path.row);
            return [null, context];
          }
          return [key, context];
        },
      ],
    });

    this.api.registerMode({
      name: 'AUTOCOMPLETE',
      cursorBetween: true,
      key_transforms: [
        async function(key, context) {
          key = transform_insert_key(key);
          if (key.length === 1) {
            // simply insert the key
            await context.session.addCharsAtCursor([key]);
            await context.session.applyHookAsync('charInserted', {}, { key });
            return [null, context];
          }
          return [key, context];
        },
      ],
      async beforeEvery(actionName: ActionName, { session, keyStream }) {
        if (actionName === 'exit-mode') {
          keyStream.save();
        } else if (!nonSavingInsertActions[actionName]) {
          // NOTE: crucially, this doesn't happen if we transform a key into nothing
          session.save();
        }
      },
      async every(actionName: ActionName, { session }: ActionContext, oldMode) {
        if ((!nonSavingInsertActions[actionName]) &&
            (oldMode === 'AUTOCOMPLETE')
          ) {
          // NOTE: crucially, this doesn't happen if we transform a key into nothing
          session.save();
        }
      },
      async exit(session: Session) {
        // unlike other modes, esc in insert mode keeps changes
        session.save();
      },
      async enter(session: Session) {
        // unlike other modes, esc in insert mode keeps changes
        session.cursor.col++; // exiting insert mode moves cursor left
        that.autocomplete_state.idx = 0;
        session.save();
      },
    });

    this.api.registerAction(
      'begin-mark',
      'Mark a line',
      async function({ session }) {
        await session.setMode('MARK');
      },
    );

    this.api.registerAction(
      'finish-mark',
      'Finish typing mark',
      async function({ session, keyStream }) {
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        const mark = await that.markstate.session.curText();
        const markedRow = that.markstate.path.row;
        const err = await that.setMark(markedRow, mark);
        if (err) { session.showMessage(err, {text_class: 'error'}); }
        await session.setMode('NORMAL');
        keyStream.save();
      }
    );

    this.api.registerMotion(
      'go-mark',
      'Go to the mark indicated by the cursor, if it exists',
      async function({ session }) {
        return async cursor => {
          const line = await session.document.getText(cursor.row);
          const mark = that.getMarkUnderCursor(line, cursor.col);
          if (!mark) {
            session.showMessage(`Cursor should be over a mark link`);
            return;
          }
          const allMarks = await that.listMarks();
          if (mark in allMarks) {
            const path = allMarks[mark];
            await session.zoomInto(path);
          } else {
            // create new row with mark
            const parent = session.cursor.path.parent;
            if (parent === null) {
              throw Error('cursor parent path is null');
            }
            let serialized_row: SerializedBlock = {
              text: mark,
              collapsed: false,
              plugins: { mark: mark },
              children: [],
            };
            const addedPaths = await session.addBlocks(parent, -1, [serialized_row], {setCursor: 'first'});
            await that.api.updatedDataForRender(parent.row);
          }
        };
      },
    );

    this.api.registerAction(
      'set-mark-row-contents',
      'Set a mark with the current row text',
      async function({ session, keyStream }) {
        const err = await that.setMark(session.cursor.row, await session.document.getText(session.cursor.row));
        if (err) { session.showMessage(err, {text_class: 'error'}); }
        keyStream.save();
      },
    );

    this.api.registerAction(
      'delete-mark',
      'Delete mark at cursor',
      async function({ session, keyStream }) {
        const err = await that.setMark(session.cursor.row, '');
        if (err) { session.showMessage(err, {text_class: 'error'}); }
        keyStream.save();
      },
    );

    this.api.registerAction(
      'autocomplete-up',
      'Select above row in menu',
      async function({ keyStream }) {
        const n = that.autocomplete_state.matches.length;
        that.autocomplete_state.idx = ((that.autocomplete_state.idx % n) + n + n - 1) % n;
        keyStream.save();
      },
    );

    this.api.registerAction(
      'autocomplete-down',
      'Select below row in menu',
      async function({ keyStream }) {
        const n = that.autocomplete_state.matches.length;
        that.autocomplete_state.idx = ((that.autocomplete_state.idx % n) + n + n + 1) % n;
        keyStream.save();
      },
    );

    // Handles enter in autocomplete
    this.api.registerAction(
      'autocomplete-select',
      'Select autocomplete option',
      async function() {
        const line = await that.document.getText(that.session.cursor.row);
        // Set mark text
        const matches = that.getMarkMatches(line);
        const cursor = that.session.cursor;
        const match = that.autocomplete_state.matches[that.autocomplete_state.idx];
        await Promise.all(matches.map(async pos => {
          if (cursor.col >= pos[0] && cursor.col <= pos[1]) {
            const start = line[pos[0]] === '@' ? pos[0] + 1 : pos[0] + 2;
            const end = line[pos[0]] === '@' ? pos[1] : pos[1] - 2;
            const mutation = new ChangeChars(cursor.row, start, end - start, undefined, match.split(''));
            await that.session.do(mutation);
            cursor.col = start + match.length;
            that.autocomplete_state.idx = 0;
          }
        }));
    });
    this.api.registerAction(
      'search-marks',
      'Go to (search for) a mark',
      async function({ session }) {
        await session.setMode('SEARCH');
        const marks = await that.listMarks();
        session.menu = new Menu(async (text) => {
          // find marks that start with the prefix
          const findMarks = async (_document: Document, query: string, nresults = 10) => {
            const results: Array<{
              path: Path, mark: Mark,
            }> = []; // list of paths
            const matches = that.searchMark(query);
            for (const mark of matches) {
              const path = marks[mark];
              results.push({ path, mark });
              if (nresults > 0 && results.length === nresults) {
                break;
              }
            }
            return results;
          };

          return await Promise.all(
            (await findMarks(session.document, text)).map(
              async ({ path, mark }) => {
                const line = await session.document.getLine(path.row);
                return {
                  contents: line,
                  renderHook(lineDiv: React.ReactElement<any>) {
                    return (
                      <span>
                        <span key={`mark_${mark}`}
                          style={{
                            ...getStyles(session.clientStore, ['theme-bg-tertiary', 'theme-trim']),
                            ...markStyle
                          }}
                        >
                          {mark}
                        </span>
                        {lineDiv}
                      </span>
                    );
                  },
                  fn: async () => await session.zoomInto(path),
                  yank_fn: async () => await session.yankBlocksClone(path, 1),
                };
              }
            )
          );
        });
      }
    );

    this.api.registerAction(
      'move-cursor-mark',
      'Move the cursor within the mark being edited (according to the specified motion)',
      async function({ motion }) {
        if (motion == null) {
          throw new Error('Expected a motion!');
        }
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        await motion(that.markstate.session.cursor, {pastEnd: true});
      },
      { acceptsMotion: true },
    );

    this.api.registerAction(
      'mark-delete-char-before',
      'Delete last character (i.e. backspace key)',
      async function() {
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        await that.markstate.session.deleteAtCursor();
      },
    );

    this.api.registerAction(
      'mark-delete-char-after',
      'Delete character at the cursor (i.e. del key)',
      async function() {
        if (that.markstate === null) {
          throw new Error('Mark state null in mark mode');
        }
        await that.markstate.session.delCharsAfterCursor(1);
      },
    );

    this.api.registerDefaultMappings(
      'AUTOCOMPLETE',
      Object.assign({
        'autocomplete-up': [['up']],
        'autocomplete-down': [['down']],
        'autocomplete-select': [['enter']],
      }, _.omit({...INSERT_MODE_MAPPINGS, ...INSERT_MOTION_MAPPINGS}, ['motion-up', 'motion-down', 'split-line']))
    );

    this.api.registerDefaultMappings(
      'MARK',
      Object.assign({
        'toggle-help': [['ctrl+?']],
        'move-cursor-mark': [[motionKey]],
        'finish-mark': [['enter']],
        'mark-delete-char-after': [['delete']],
        'mark-delete-char-before': [['backspace'], ['shift+backspace']],
        'exit-mode': [['esc'], ['ctrl+c']],
      }, _.pick(INSERT_MOTION_MAPPINGS, SINGLE_LINE_MOTIONS))
    );

    this.api.registerDefaultMappings(
      'NORMAL',
      {
        'begin-mark': [['m']],
        'set-mark-row-contents': [['M']],
        'go-mark': [['g', 'm']],
        'delete-mark': [['d', 'm']],
        'search-marks': [['\''], ['`']],
      },
    );

    this.api.registerHook('document', 'pluginRowContents', async (obj, { row }) => {
      const mark = await this.getMark(row);
      const marking = this.markstate && (this.markstate.path.row === row);
      obj.marks = { mark, marking };
      if (this.markstate && marking) {
        obj.marks.markText = await this.markstate.session.document.getLine(
          this.markstate.session.cursor.path.row
        );
        obj.marks.markCol = this.markstate.session.cursor.col;
      }
      return obj;
    });

    this.api.registerHook('session', 'renderLineOptions', (options, info) => {
      if (info.pluginData.marks && info.pluginData.marks.marking) {
        options.cursors = {};
      }
      return options;
    });

    // Renders mark to the left of line
    this.api.registerHook('session', 'renderLineContents', (lineContents, info) => {
      const { pluginData } = info;
      if (pluginData.marks) {
        if (pluginData.marks.marking) {
          lineContents.unshift(
            <span key='mark'
              style={{
                ...getStyles(this.api.session.clientStore, ['theme-bg-tertiary', 'theme-trim-accent']),
                ...markStyle
              }}
            >
              <LineComponent
                lineData={pluginData.marks.markText}
                cursors={{
                  [pluginData.marks.markCol]: true,
                }}
                cursorStyle={getStyles(this.api.session.clientStore, ['theme-cursor'])}
                highlightStyle={getStyles(this.api.session.clientStore, ['theme-bg-highlight'])}
                linksStyle={getStyles(this.api.session.clientStore, ['theme-link'])}
                accentStyle={getStyles(this.api.session.clientStore, ['theme-text-accent'])}
                cursorBetween={true}
              />
            </span>
          );
        } else {
          const mark = pluginData.marks.mark;
          if (mark) {
            lineContents.unshift(
              <span key='mark'
                style={{
                  ...getStyles(this.api.session.clientStore, ['theme-bg-tertiary']),
                  ...markStyle
                }}
              >
                {mark}
              </span>
            );
          }
        }
      }
      return lineContents;
    });

    // Detect when to enter or exit autocomplete mode
    this.api.registerHook('session', 'colChange', async (_, { newCol }) => {
        const line: string = (await this.session.curLine()).join('');
        const matches = this.getMarkMatches(line);
        let inAutocomplete = false;
        for (const pos of matches) {
          const start = pos[0], end = pos[1];
          if (newCol >= start + 1 && newCol <= end) {
            const query = this.parseMarkMatch(line.slice(start, end));
            this.autocomplete_state.matches = this.searchMark(query).slice(0, 10); // only show first 10 results
            if (this.autocomplete_state.matches.length > 0) {
              inAutocomplete = true;
            }
          }
        }
        if (inAutocomplete && this.session.mode === 'INSERT' && this.autocomplete_state.idx !== -1) {
          this.autocomplete_state.idx = -1; // make sure this only runs once
          await this.session.setMode('AUTOCOMPLETE');
        }
        if (!inAutocomplete && this.session.mode === 'AUTOCOMPLETE') {
          await this.session.setMode('INSERT');
        }
      }
    )

    // Renders autocomplete menu
    this.api.registerHook('session', 'renderCharChildren', (children, info) => {
      if (this.session.mode !== 'AUTOCOMPLETE') {
        return;
      }
      const { lineData, column, cursors } = info;
      const line: string = lineData.join('');
      const cursor = this.session.cursor;
      if (Object.keys(cursors).length > 0) {
        const matches = this.getMarkMatches(line);
        matches.map(pos => {
          const start = pos[0], end = pos[1];
          if (cursor.col >= start + 1 && cursor.col <= end) {
            if (start === column) {
              const query = this.parseMarkMatch(line.slice(start, end));
              this.autocomplete_state.matches = this.searchMark(query).slice(0, 10); // only show first 10 results
              if (matches.length === 0) {
                throw('In autocomplete with 0 matches');
              }
              children.push(
                <span key='autocompleteAnchor'
                  style={{
                    position: 'relative'
                  }}>
                  <span key='autocompleteContainer'
                    style={{
                      ...getStyles(this.api.session.clientStore, ['theme-bg-tertiary']),
                      position: 'absolute',
                      zIndex: 1000,
                      width: '200px',
                      top: '1.2em'
                    }}
                  > 
                    {this.autocomplete_state.matches.map((mark, idx) => {
                      const theme = (this.autocomplete_state.idx === idx) ? 'theme-bg-secondary' : 'theme-bg-tertiary';
                      return (
                        <div key={`autocomplete-row-${idx}`}
                          style={{
                            ...getStyles(this.api.session.clientStore, [theme]),
                          }}>
                          {mark}
                        </div>
                      );
                    })}
                  </span>
                </span>
              );
            }

          }
        });
      }
      return children;
    });

    // Renders mark links
    this.api.registerHook('session', 'renderLineTokenHook', (tokenizer) => {
      return tokenizer.then(new PartialUnfolder<Token, React.ReactNode>((
        token: Token, emit: EmitFn<React.ReactNode>, wrapped: Tokenizer
      ) => {
        if (this.session.mode === 'NORMAL') {
          const matches = this.getMarkMatches(token.text);
          matches.map(pos => {
            let start = pos[0];
            let end = pos[1];
            const mark = this.parseMarkMatch(token.text.slice(start, end));
            const path = this.marks_to_paths[mark];
            if (path) {
              token.info.slice(start, end).forEach((char_info) => {
                char_info.renderOptions.divType = 'a';
                char_info.renderOptions.style = char_info.renderOptions.style || {};
                Object.assign(char_info.renderOptions.style, getStyles(this.session.clientStore, ['theme-link']));
                char_info.renderOptions.onClick = async () => {
                  await this.session.zoomInto(path);
                  this.session.save();
                };
              });
            }
          });
        }
        emit(...wrapped.unfold(token));
        }));
    });

    this.api.registerListener('document', 'afterDetach', async () => {
      this.computeMarksToPaths(); // FIRE AND FORGET
    });
    this.computeMarksToPaths(); // FIRE AND FORGET
  }

  // maintain global marks data structures
  //   a map: row -> mark
  //   and a second map: mark -> row
  private async _getRowsToMarks(): Promise<RowsToMarks> {
    return await this.api.getData('ids_to_marks', {});
  }
  private async _setRowsToMarks(rows_to_marks: RowsToMarks) {
    return await this.api.setData('ids_to_marks', rows_to_marks);
  }
  private async _getMarksToRows(): Promise<MarksToRows> {
    return await this.api.getData('marks_to_ids', {});
  }
  private async _setMarksToRows(mark_to_rows: MarksToRows) {
    return await this.api.setData('marks_to_ids', mark_to_rows);
  }

  private async _sanityCheckMarks() {
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    const [
      marks_to_rows,
      rows_to_marks,
    ] = await Promise.all([
      this._getMarksToRows(),
      this._getRowsToMarks(),
    ]);
    const marks_to_rows2: MarksToRows = {};
    for (const row in rows_to_marks) {
      const mark = rows_to_marks[row];
      marks_to_rows2[mark] = parseInt(row, 10);
    }
    errors.assert_deep_equals(marks_to_rows, marks_to_rows2, 'Inconsistent rows_to_marks');
  }

  // get mark for an row, '' if it doesn't exist
  public async getMark(row: Row): Promise<Mark | null> {
    const marks = await this._getRowsToMarks();
    return marks[row] || null;
  }

  private async _setMark(row: Row, mark: Mark) {
    await this._sanityCheckMarks();
    const marks_to_rows = await this._getMarksToRows();
    const rows_to_marks = await this._getRowsToMarks();
    errors.assert(!marks_to_rows.hasOwnProperty(mark));
    errors.assert(!rows_to_marks.hasOwnProperty(row));
    marks_to_rows[mark] = row;
    rows_to_marks[row] = mark;
    await this._setMarksToRows(marks_to_rows);
    await this._setRowsToMarks(rows_to_marks);
    await this._sanityCheckMarks();
    this.computeMarksToPaths();
  }

  private async _unsetMark(row: Row, mark: Mark) {
    await this._sanityCheckMarks();
    const marks_to_rows = await this._getMarksToRows();
    const rows_to_marks = await this._getRowsToMarks();
    errors.assert_equals(marks_to_rows[mark], row);
    errors.assert_equals(rows_to_marks[row], mark);
    delete marks_to_rows[mark];
    delete rows_to_marks[row];
    await this._setMarksToRows(marks_to_rows);
    await this._setRowsToMarks(rows_to_marks);
    await this._sanityCheckMarks();
    this.computeMarksToPaths();
  }

  // compute set of paths, used for rendering
  // this is a fire and forget function.
  // this.marks_to_paths  is used only for the marks word hook
  // so we don't care if it's a bit out of date
  private computeMarksToPaths() {
    (async () => {
      this.marks_to_paths = await this.listMarks();
    })();
  }

  public async listMarks(): Promise<{[mark: string]: Path}> {
    await this._sanityCheckMarks();
    const marks_to_rows = await this._getMarksToRows();

    const all_marks: {[mark: string]: Path} = {};
    await Promise.all(
      Object.keys(marks_to_rows).map(async (mark) => {
        const row = marks_to_rows[mark];
        const path = await this.document.canonicalPath(row);
        if (path !== null) {
          all_marks[mark] = path;
        }
      })
    );
    return all_marks;
  }

  // Set the mark for row
  // Returns whether setting mark succeeded
  public async setMark(row: Row, mark: Mark | null = null) {
    const marks_to_rows = await this._getMarksToRows();
    const rows_to_marks = await this._getRowsToMarks();
    const oldmark = rows_to_marks[row];

    if (!(oldmark || mark)) {
      return 'No mark to delete!';
    }

    if (mark && (mark in marks_to_rows)) {
      if (marks_to_rows[mark] === row) {
        return 'Already marked, nothing to do!';
      }

      const other_row = marks_to_rows[mark];
      if (await this.document.isAttached(other_row)) {
        return `Mark '${mark}' was already taken!`;
      } else {
        await this.session.do(new this.UnsetMark(other_row));
      }
    }

    if (oldmark) {
      await this.session.do(new this.UnsetMark(row));
    }

    if (mark) {
      await this.session.do(new this.SetMark(row, mark));
    }

    return null;
  }

  public getMarkMatches(line: string) {
    const matches = [];
    let index = 0;
    const regex = /(@\S*|\[\[([^\]]*)\]\])/;
    while (true) {
      let match = regex.exec(line.slice(index));
      if (!match) { break; }
      let start = index + match.index;
      let end = start + match[0].length;
      index = end;
      matches.push([start, end]);

    }
    return matches;
  }

  public parseMarkMatch(match: string) {
    const end = match.length;
    let markStart = 0, markEnd = end;
    if (match[0] === '@') {
      markStart = 1;
      markEnd = end;
    }
    if (match[0] === '[') {
      markStart = 2;
      markEnd = end - 2;
    }
    const mark = match.slice(markStart, markEnd).replace(/(\.|!|\?)+$/g, '');
    return mark;
  }

  public getMarkUnderCursor(line: string, col: Col): string | null {
    const matches = this.getMarkMatches(line);
    let mark = null;
    matches.map((pos) => {
      if (col >= pos[0] && col <= pos[1]) {
        mark = this.parseMarkMatch(line.slice(pos[0], pos[1]));
      }
    });
    return mark;
  }

  public searchMark(query: string) {
    const marks = Object.keys(this.marks_to_paths);
    const matches = marks.filter(mark => {
      return mark.toLowerCase().includes(query.toLowerCase());
    }).sort((a, b) => {
      // marks that match prefix first, shortest results first
      const aPrefix = a.startsWith(query);
      const bPrefix = b.startsWith(query);
      if (aPrefix !== bPrefix) {
        return aPrefix ? -1 : 1;
      } else {
        return a.length - b.length;
      }
    });
    return matches;
  }
}

// NOTE: because listing marks filters, disabling is okay

export const pluginName = 'Marks';

registerPlugin<MarksPlugin>(
  {
    name: pluginName,
    author: 'Jeff Wu',
    description:
      `Lets you tag a row with a string, and then reference that row with @markname.
  Fast search for marked rows, using '.`,
  },
  async (api) => {
    const marksPlugin = new MarksPlugin(api);
    await marksPlugin.enable();
    return marksPlugin;
  },
  (api) => api.deregisterAll(),
);

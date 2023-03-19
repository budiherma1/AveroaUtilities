import { Model as Objection } from 'objection';
import { faker } from '@faker-js/faker';
import validator from 'validator';
import FilterSearch from './FilterSearch.js';
import Knex from 'knex';
import config from '../../../config/database.js';

class Model extends Objection {
  static migrationUp(knex) {
    return knex.schema.createTable(this.tableName, (table) => {
      for (const key in this.column) {
        if (typeof this.column[key].migration === 'function') {
          this.column[key].migration({ table, knex, column: key });
        }
      }

      if (this.timestamp !== false) {
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.bigint('created_by', 14).nullable();
        table.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')).nullable();
        table.bigint('updated_by', 14).nullable();
        table.timestamp('deleted_at').nullable();
        table.bigint('deleted_by', 14).nullable();
      }
    });
  }

  static migrationDown(knex) {
    return knex.schema.dropTable(this.tableName);
  }

  static async seeder() {
    const knex = arguments[arguments.length - 1];
    const number = typeof arguments[0] === 'number' ? arguments[0] : 1;
    await knex(this.tableName).del();
    const data = [];

    for (let i = 1; i <= number; i++) {
      const seeds = {};
      const column = { ...this.column };

      for (const key in column) {
        if (typeof column[key].seed === 'function') {
          const seed = column[key].seed(faker);
          seeds[key] = seed;
          column[key].value = seed;
        }
      }

      data.push(seeds);
    }

    await knex(this.tableName).insert(data);
  }

  static async seederCustom() {
    const [number, cb, knex] = arguments;

    await knex(this.tableName).del();
    const data = [];

    Objection.knex(Knex(config));

    for (let i = 1; i <= number; i++) {
      const seeds = {};
      const column = { ...this.column };
      const custom = await cb();
      for (const key in column) {
        if (key in custom) {
          seeds[key] = custom[key];
          column[key].value = custom[key];
        } else if (typeof column[key].seed === 'function') {
          const seed = column[key].seed(faker);
          seeds[key] = seed;
          column[key].value = seed;
        }
      }

      data.push(seeds);
    }

    await knex(this.tableName).insert(data);
  }

  static async validationRouter(req, res, next, additional = {}) {
    const validationResult = [];
    const data = req.body;
    const sanitized = {};
    const dataFiles = {};

    if (req.files !== undefined) {
      for (let file of req.files) {
        if (file.fieldname in this.column && this.column[file.fieldname]?.flag?.upload === true) {
          dataFiles[file.fieldname] = file;
        }
      }
    }

    let theColumns = this.column;
    if (this.timestamp !== false) {
      theColumns = {
        ...theColumns,
        created_at: { flag: { required: false } },
        created_by: { flag: { required: false } },
        updated_at: { flag: { required: false } },
        updated_by: { flag: { required: false } },
        deleted_at: { flag: { required: false } },
        deleted_by: { flag: { required: false } },
      }
    }

    for (const key in theColumns) {

      if (additional.create && theColumns[key].flag?.required !== false && !data[key] && theColumns[key]?.flag?.upload !== true) {
        return res.send({ status: false, data: { column: key, message: 'required' } });
      } else if (theColumns[key]?.flag?.upload === true && !(key in dataFiles)) {
        return res.send({ status: false, data: { column: key, message: 'required' } });
      }

      if (key in data) {
        const vColumn = [];
        sanitized[key] = data[key];

        const allValidation = typeof theColumns[key].validation === 'object' ? theColumns[key].validation : [];

        if (theColumns[key].flag?.unique == true) {
          let initModel = this.query();
          initModel.where(key, '=', data[key]);
          if (!additional.create) {
            initModel.where('id', '!=', req.params.id)
          }
          initModel = await initModel;

          if (Object.keys(initModel).length > 0) {
            vColumn.push(`duplicate value ${data[key]}`)
          }
        }
        if (allValidation.length) {

          for (const v of allValidation) {
            if (typeof v.run === 'function') {
              const validation = v.run({ validator, value: `${data[key]}` });
              if (!validation) {
                vColumn.push(v.msg);
              }
            }
          }

        }

        if (vColumn.length) {
          const result = { status: false, data: { column: key, message: vColumn } };
          return res.send(result);
        }
      }
    }

    const result = { status: false, data: validationResult };
    if (validationResult.length) {
      return res.send(result);
    }
    req.bodyRaw = { ...req.body };
    req.body = sanitized;
    if (Object.keys(dataFiles).length > 0) {
      req.dataFiles = dataFiles;
    }
    return next();
  }

  // Map req.body into req.dataReq
  static mapRequest(req, res, next, additional = {}) {
    if (additional?.type === 'multipart') {
      req.isFormData = true;
    }
    if (additional?.pref) {
      req.routeData = additional.pref;
    }
    req.dataReq = req.body;
    return next();
  }

  static filterSearch(filter) {
    return FilterSearch.model(this, filter);
  }

  // check parameter req.params.id get request route/id
  static async checkParamId(req, res, next) {
    if (req.params?.id) {
      const count = await this.query().findById(req.params.id).count();
      if (count['count(*)'] > 0) {
        return next();
      }
      return res.send({ status: false, message: `ID ${req.params.id} doesn't exist` });
    }
    return next();
  }

  static validation(request, type = 'create') {
    const validationResult = [];
    //
    if (type === 'create') {
      for (const col in this.column) {
        if (this.column[col].flag?.required !== false && !request[col]) {
          return { status: false, data: { column: col, message: 'required' } };
        }
      }
    }
    //
    for (const key in request) {
      if (key in this.column) {
        const vColumn = [];

        if (type !== 'create') {
          if (this.column[key].flag.required !== false) {
            vColumn.push('required');
          }
        }

        const allValidation = typeof this.column[key].validation === 'object' ? this.column[key].validation : [];
        if (allValidation.length) {
          for (const v of allValidation) {
            if (typeof v.run === 'function') {
              const validation = v.run({ validator, value: `${request[key]}` });
              if (!validation) {
                vColumn.push(v.msg);
                // return { status: false, data: { column: key, message: v.message } }
              }
            }
          }

          if (vColumn.length) {
            // validationResult.push({ column: key, message: vColumn })
            const result = { status: false, data: { column: key, message: vColumn } };
            return result;
          }
        }
      }
    }

    if (validationResult.length) {
      return { status: false, data: validationResult };
    }

    return { status: true };
  }

  static search(query, search) {
    for (const key in this.column) {
      if (this.column[key].flag?.search !== false) {
        query = query.orWhere(key, 'like', `%${search}%`);
      }
    }
    return query;
  }

  // static async validationRouter(req, res, next, additional = {}) {
  //   const validationResult = [];
  //   const data = req.body;
  //   const sanitized = {}
  //   console.log(data);
  //   console.log(req.body);
  //   console.log(req.query);
  //   console.log(req.files);
  //   console.log(req.file);
  //   //

  //     console.log(2222);
  //     for (const col in this.column) {
  //       // 
  //       if (req.files !== undefined) {
  //           if (this.column[col].flag?.upload === true) {
  //             for(let file of req.files) {
  //               if (file.fieldname === col) {
  //                 req.body[col] = file;
  //               }
  //             }
  //           }
  //       }
  //       // 
  //       console.log(data);
  //       if (additional.create) {

  //         if (this.column[col].flag?.required !== false && !data[col]) {
  //           return res.send({ status: false, data: { column: col, message: 'required' } });
  //         }
  //       }
  //     }
  //   //
  //   for (const key in data) {
  //     console.log(34343434);
  //     console.log(key)
  //     console.log(data[key])
  //     console.log(34343434);
  //     if (key in this.column) {
  //       const vColumn = [];


  //       if (!additional.create) {
  //         if (this.column[key].flag?.required !== false && !data[key]) {
  //           vColumn.push('required');
  //         }
  //       }


  //       const allValidation = typeof this.column[key].validation === 'object' ? this.column[key].validation : [];

  //       if (allValidation.length || this.column[key].flag?.unique == true) {
  //         if (this.column[key].flag?.unique == true) {
  //           let initModel = this.query();
  //           // console.log(initModel);
  //           initModel.where(key, '=', data[key]);
  //             if (!additional.create) {
  //               console.log('updateeeeee');
  //               initModel.where('id', '!=', req.params.id)
  //             }
  //             initModel = await initModel;
  //             // console.log(initModel);

  //             if (Object.keys(initModel).length > 0) {
  //               vColumn.push(`duplicate value ${data[key]}`)
  //             }
  //         } else {

  //           for (const v of allValidation) {
  //             if (typeof v.run === 'function') {
  //               const validation = v.run({ validator, value: `${data[key]}` });
  //               if (!validation) {
  //                 vColumn.push(v.msg);
  //                 // return { status: false, data: { column: key, message: v.message } }
  //               }
  //             }
  //         }

  //         }
  //       }

  //       if (vColumn.length) {
  //         // validationResult.push({ column: key, message: vColumn })
  //         const result = { status: false, data: { column: key, message: vColumn } };
  //         return res.send(result);
  //       }
  //     }
  //   }
  //   const result = { status: false, data: validationResult };
  //   if (validationResult.length) {
  //     return res.send(result);
  //   }
  //   return next();
  // }

  // sanitize body request
  // static sanitizeRequest(req, res, next, additional = {}) {
  //   const sanitized = {};

  //   const data = req.body;

  //   for (const key in data) {
  //     if (key in this.column) {
  //       sanitized[key] = data[key];
  //     }
  //   }
  //     req.body = sanitized;

  //   return next();
  // }
}

export default Model;

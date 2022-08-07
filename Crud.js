import moment from 'moment';

class Crud {
  static async create(model, req, option = {}) {
    const importModel = (await import(`@averoa/models`))[model];
    let additionalCreate = option.create ?? {}
    const data = await importModel.query().insert({ ...req.dataReq, ...additionalCreate });
    return data;
  }

  static async findAll(model, req, option = {}) {
    const importModel = (await import(`@averoa/models`))[model];
    // const data = await FilterSearch.knex(DB('teacher'), req);
    const data = await importModel.filterSearch.call(importModel, req);
    return data;
  }

  static async findOne(model, req, option = {}) {
    const importModel = (await import(`@averoa/models`))[model];
    const data = importModel.query();
    if (option.relations) {
      data.withGraphFetched(option.relations);
    }
    data.findById(req.params.id);
    return data;
  }

  static async update(model, req, option = {}) {
    const importModel = (await import(`@averoa/models`))[model];
    let additionalUpdate = option.update ?? {}
    const data = await importModel.query()
      .findById(req.params.id)
      .update({ ...req.dataReq, ...additionalUpdate });
    return { status: !!data };
  }

  static async delete(model, req, option = {}) {
    const importModel = (await import(`@averoa/models`))[model];
    let additionalUpdate = option.update ?? {}
    const data = await importModel.query()
      .findById(req.params.id)
      .update({ deleted_at: moment().format('YYYY-MM-DD, hh:mm:ss'), ...additionalUpdate });
    return { status: !!data };
  }
}

export default Crud;
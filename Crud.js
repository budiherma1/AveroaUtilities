import moment from 'moment';
import { UploadProvider } from '../../../app/Providers/index.js'

class Crud {
  static async create(model, req, option = {}) {
    try {

      const importModel = (await import(`@averoa/models`))[model];
      let additionalCreate = option.insert ?? {}

      let dataReq = req.dataReq ?? req.body;
      if (req.dataFiles !== undefined) {
        for (const key in req.dataFiles) {
          let upload = await UploadProvider.upload(req.dataFiles[key], req.routeData)
          dataReq[key] = upload;
        }
      }

      const data = await importModel.query().insert({ ...dataReq, ...additionalCreate });
      return { status: true, data };
    } catch (e) {
      return { status: false, message: e.message }
    }
  }

  static async findAll(model, req, option = {}) {
    const importModel = (await import(`@averoa/models`))[model];
    // const data = await FilterSearch.knex(DB('teacher'), req);
    let isDatatable = req.query?.['$datatable'] ? true : false;
    let datatableDraw = req.query?.['$draw'];
    if (isDatatable) {
      delete req.query['$draw'];
      delete req.query['$datatable'];
      delete req.query['_'];
    }
    const data = await importModel.filterSearch.call(importModel, req);

    if (isDatatable && data.status) {
      return {
        draw: datatableDraw,
        recordsTotal: data.metadata?.item_total ?? 0,
        recordsFiltered: data.metadata?.item_total ?? 0,
        data: data.data,
      }
    }

    return data;
  }

  static async findOne(model, req, option = {}) {
    try {

      const importModel = (await import(`@averoa/models`))[model];
      const data = importModel.query();

      if (req.query?.$relations) {
        data.withGraphFetched(req.query.$relations);
      }
      if (req.query?.$select) {
        let arrSelect = req.query.$select.replaceAll(' ', '').split(',');
        data.select(arrSelect);
      }

      let result = await data.findById(req.params.id);
      return { status: true, data: result };
    } catch (e) {
      return { status: false, message: e.message }
    }
  }

  static async update(model, req, option = {}) {
    try {

      const importModel = (await import(`@averoa/models`))[model];
      let additionalUpdate = option.update ?? {}

      let dataReq = req.dataReq ?? req.body;
      if (req.dataFiles !== undefined) {
        let oldData = await importModel.query().findById(req.params.id);
        for (const key in req.dataFiles) {
          let upload = await UploadProvider.upload(req.dataFiles[key], req.routeData, oldData[key])
          dataReq[key] = upload;
        }
      }

      const data = await importModel.query()
        .findById(req.params.id)
        .update({ ...dataReq, ...additionalUpdate });
      return { status: !!data };
    } catch (e) {
      return { status: false, message: e.message }
    }
  }

  static async delete(model, req, option = {}) {
    try {

      const importModel = (await import(`@averoa/models`))[model];
      let additionalUpdate = option.update ?? {}
      const data = await importModel.query()
        .findById(req.params.id)
        .update({ deleted_at: moment().format('YYYY-MM-DD hh:mm:ss'), ...additionalUpdate });
      return { status: !!data };
    } catch (e) {
      return { status: false, message: e.message }
    }
  }
}

export default Crud;

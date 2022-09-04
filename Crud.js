import moment from 'moment';
import { UploadProvider } from '../../../app/Providers/index.js'

class Crud {
  static async create(model, req, option = {}) {
    try {

      const importModel = (await import(`@averoa/models`))[model];
      let additionalCreate = option.insert ?? {}
  
      if (req.dataFiles !== undefined) {
        for(const key in req.dataFiles) {
          let upload = await UploadProvider.upload(req.dataFiles[key], req.routeData)
          req.dataReq[key] = upload;
        }
      }
  
      const data = await importModel.query().insert({ ...req.dataReq, ...additionalCreate });
      return { status: true, data };
    } catch (e) {
      return { status: false, message: e.message }
    }
  }

  static async findAll(model, req, option = {}) {
    const importModel = (await import(`@averoa/models`))[model];
    // const data = await FilterSearch.knex(DB('teacher'), req);
    const data = await importModel.filterSearch.call(importModel, req);
    return data;
  }

  static async findOne(model, req, option = {}) {
    try {

      const importModel = (await import(`@averoa/models`))[model];
      const data = importModel.query();
      if (option.relations) {
        data.withGraphFetched(option.relations);
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

      if (req.dataFiles !== undefined) {
        let oldData = await importModel.query().findById(req.params.id);
        for (const key in req.dataFiles) {
          let upload = await UploadProvider.upload(req.dataFiles[key], req.routeData, oldData[key])
          req.dataReq[key] = upload;
        }
      }

      const data = await importModel.query()
        .findById(req.params.id)
        .update({ ...req.dataReq, ...additionalUpdate });
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
        .update({ deleted_at: moment().format('YYYY-MM-DD, hh:mm:ss'), ...additionalUpdate });
      return { status: !!data };
    } catch (e) {
      return { status: false, message: e.message }
    }
  }
}

export default Crud;

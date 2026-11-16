import { Model } from '../../../../../index.js';

// no timestamps → no soft delete, hard delete
class Tags extends Model {
  static tableName = 'tags';

  static timestamp = false;

  static column = {
    id: { migration: (m) => m.table.increments(m.column).primary(), flag: { required: false } },
    label: { migration: (m) => m.table.string(m.column, 50), flag: { required: true } },
  };
}

export default Tags;

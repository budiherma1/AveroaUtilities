import { Model } from '../../../../../index.js';

class Posts extends Model {
  static tableName = 'it_posts';

  static timestamp = true;

  static column = {
    id: {
      migration: (m) => m.table.increments(m.column).primary(),
      flag: { required: false },
    },
    user_id: {
      migration: (m) => m.table.integer(m.column).nullable(),
      flag: { required: true },
    },
    title: {
      migration: (m) => m.table.string(m.column, 100).nullable(),
      flag: { required: true },
    },
  };
}

export default Posts;

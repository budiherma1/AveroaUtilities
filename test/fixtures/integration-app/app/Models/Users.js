import { Model } from '../../../../../index.js';
import Posts from './Posts.js';

// No config/database.js in this fixture app: DB is built from DB_* env vars.
class Users extends Model {
  static tableName = 'it_users';

  static timestamp = true;

  static hidden = ['password'];

  static allowWithTrashed = true;

  static column = {
    id: {
      migration: (m) => m.table.increments(m.column).primary(),
      flag: { required: false },
    },
    name: {
      migration: (m) => m.table.string(m.column, 50).nullable(),
      seed: (f) => f.person.firstName(),
      flag: { required: true },
    },
    email: {
      migration: (m) => m.table.string(m.column, 100).nullable(),
      seed: (f) => f.internet.email(),
      flag: { required: true, unique: true },
      validation: [{ run: (v) => v.validator.isEmail(v.value), msg: 'email format required' }],
    },
    age: {
      migration: (m) => m.table.integer(m.column).nullable(),
      seed: (f) => f.number.int({ min: 18, max: 90 }),
      flag: { required: false },
    },
    password: {
      migration: (m) => m.table.string(m.column, 100).nullable(),
      seed: () => 'secret',
      flag: { required: false },
    },
  };

  static relationMappings = () => ({
    posts: {
      relation: Model.HasManyRelation,
      modelClass: Posts,
      join: { from: 'it_users.id', to: 'it_posts.user_id' },
    },
  });
}

export default Users;

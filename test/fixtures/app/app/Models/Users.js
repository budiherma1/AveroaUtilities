import { Model } from '../../../../../index.js';
import Posts from './Posts.js';

class Users extends Model {
  static tableName = 'users';

  static timestamp = true;

  static hidden = ['password'];

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
      join: { from: 'users.id', to: 'posts.user_id' },
    },
  });
}

export default Users;

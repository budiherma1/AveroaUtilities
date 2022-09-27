class FilterSearch {
	static async model(table, req, config = {}) {
		const filterSearch = new this;
		try {
			return await filterSearch.init('model', table, req, config);
		} catch (e) {
			return {
				status: false,
				message: e.message,
			}
		}
	}

	static async knex(table, req, config = {}) {
		if (!config.column) {
			return { status: false, message: 'need to define column array' };
		}
		const filterSearch = new this;
		try {
			return await filterSearch.init('knex', table, req, config);
		} catch (e) {
			return {
				status: false,
				message: e.message,
			}
		}
	}

	async init(type, table, req, config) {
		this.timestampColumn = ['created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by'];
		this.pagination = ['limit', 'page'];
		if (type === 'model') {
			this.timestamp = table.timestamp
		} else {
			this.timestamp = config.timestamp ? true : false;
		}
		this.table = table;
		this.type = type;
		this.filter = req.query;
		this.data = type === 'model' ? table.query() : table;
		if (this.filter['$relations']) {
			this.data.joinRelated(this.filter['$relations'])
		}
		this.config = config;

		if (!Object.keys(this.filter).includes('limit')) {
			this.filter.limit = this.config.limit ?? 10;
		}
		if (!Object.keys(this.filter).includes('page')) {
			this.filter.page = this.config.page ?? 1;
		}

		let query = this.exec();
		let dataCount = await query.clone().count();
		let count = dataCount[0]['count(*)'];

		let limit = this.filter.limit == 0 ? count : Number(this.filter.limit)
		let page = Number(this.filter.page);

		let data = await query.limit(limit).offset((page - 1) * limit);
		const page_total = limit > count ? 1 : Math.round(count / limit);
		return {
			status: true,
			metadata: {
				item_total: count,
				per_page: limit > count ? count : limit,
				page_total,
				current_page: page,
				has_next_page: page < page_total,
				has_prev_page: page !== 1 && page <= page_total,
			},
			data,
		}
	}

	// filtering params column, only existing column that will be processing 
	sanitize(k) {
		k = k.replace(`${this.table.tableName}.`, '')
		if (this.type === 'model') {
			if (this.filter['$relations']) {
				let split = k.split('.')
				if (this.filter['$relations'].includes(split[0])) {
					console.log('sip');
					return true;
				}
			} 
				if (k in this.table.column || (this.timestamp && this.timestampColumn.includes(k))) {
					return true;
				}
		} else if (this.config.column.includes(k) || (this.timestamp && this.timestampColumn.includes(k))) {
			return true;
		}
		return false;
	}

	// processing params which have '|' flag
	queryBuildMulti(par, key, cb) {
		const split = key.replace(par, '').split('|');
		this.data.where((builder) => {
			for (const col of split) {
				if (this.sanitize(col)) {
					cb(builder, col);
				}
			}
			return builder;
		});
	}

	// converting query params into query builder both '|' and non '|'
	filterProcess(par, key, cb1, cb2) {
		if (key.includes('|')) {
			this.queryBuildMulti(par, key, (builder, col) => {
				cb1(builder, col, par);
			});
		} if (this.sanitize(key.replace(par, ''))) {
			const col = key.replace(par, '');
			cb2(col);
		}
	}

	// execute filtering
	exec() {
		for (const key in this.filter) {
			const pVal = this.filter[key];

			if (this.pagination.includes(key)) {
				continue;
			}

			if (key.split(':')[1] === 'eq') {
				this.filterProcess(':eq', key, (builder, col) => {
					builder.orWhere(col, '=', pVal);
				}, (col) => {
					this.data.where(col, '=', pVal);
				});
			} else if (key.split(':')[1] === 'neq') {
				this.filterProcess(':neq', key, (builder, col) => {
					builder.orWhere(col, '!=', pVal);
				}, (col) => {
					this.data.where(col, '!=', pVal);
				});
			} else if (key.split(':')[1] === 'lt') {
				this.filterProcess(':lt', key, (builder, col) => {
					builder.orWhere(col, '<', pVal);
				}, (col) => {
					this.data.where(col, '<', pVal);
				});
			} else if (key.split(':')[1] === 'lte') {
				this.filterProcess(':lte', key, (builder, col) => {
					builder.orWhere(col, '<=', pVal);
				}, (col) => {
					this.data.where(col, '<=', pVal);
				});
			} else if (key.split(':')[1] === 'gt') {
				this.filterProcess(':gt', key, (builder, col) => {
					builder.orWhere(col, '>', pVal);
				}, (col) => {
					this.data.where(col, '>', pVal);
				});
			} else if (key.split(':')[1] === 'gte') {
				this.filterProcess(':gte', key, (builder, col) => {
					builder.orWhere(col, '>=', pVal);
				}, (col) => {
					this.data.where(col, '>=', pVal);
				});
			} else if (key.split(':')[1] === 'like') {
				this.filterProcess(':like', key, (builder, col) => {
					builder.orWhereRaw(`${col} like BINARY '${pVal}'`);
				}, (col) => {
					this.data.whereRaw(`${col} like BINARY '${pVal}'`);
				});
			} else if (key.split(':')[1] === 'ilike') {
				this.filterProcess(':ilike', key, (builder, col) => {
					builder.orWhere(col, 'like', pVal);
				}, (col) => {
					this.data.where(col, 'like', pVal);
				});
			} else if (key.split(':')[1] === 'in') {
				this.filterProcess(':in', key, (builder, col) => {
					builder.orWhereIn(col, pVal.split(','));
				}, (col) => {
					this.data.whereIn(col, pVal.split(','));
				});
			} else if (key.split(':')[1] === 'notNull') {
				this.filterProcess(':notNull', key, (builder, col) => {
					builder.orWhereNotNull(col);
				}, (col) => {
					this.data.whereNotNull(col);
				});
			} else if (key.split(':')[1] === 'isNull') {
				this.filterProcess(':isNull', key, (builder, col) => {
					builder.orWhereNull(col);
				}, (col) => {
					this.data.whereNull(col);
				});
			} else if (key.split(':')[1] === 'btwn') {
				const split = pVal.split(',');
				this.filterProcess(':btwn', key, (builder, col) => {
					builder.orWhereBetween(col, [split[0], split[1]]);
				}, (col) => {
					this.data.whereBetween(col, [split[0], split[1]]);
				});
			} else if (key === 'orderBy') {
				if (this.sanitize(pVal)) {
					this.data.orderBy(pVal);
				}
			} else if (key === 'orderByDesc') {
				if (this.sanitize(pVal)) {
					this.data.orderBy(pVal, 'desc');
				}
			} else if (key === 'groupBy') {
				if (this.sanitize(pVal)) {
					this.data.groupBy(pVal);
				}
			} else if (key === '$relations' && this.type === 'model') {
				this.data.withGraphFetched(pVal);
			} else if (this.type === 'model') {
				if (key in this.table.column || (this.timestamp && this.timestampColumn.includes(key))) {
					this.data.where(key, pVal);
				} else {
					return { status: false, message: `${key} doesn't exist` };
				}
			} else if (this.config.column.includes(key) || (this.timestamp && this.timestampColumn.includes(key))) {
				this.data.where(key, pVal);
			} else {
				return { status: false, message: `${key} doesn't exist` };
			}
		}

		return this.data;
	}
}

export default FilterSearch;

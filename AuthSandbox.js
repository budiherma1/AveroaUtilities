class Auth {
	init(req) {
		this.req = req
	}

	user() {
		return this.req.session.passport?.user ?? {};
	}
	
	check() {
		return this.req.isAuthenticated();
	}

	logout() {
		return this.req.logOut();
	}
}

export default new Auth;
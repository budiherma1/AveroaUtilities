export const UploadProvider = {
  calls: [],
  async upload(file, route, oldFile = '') {
    this.calls.push({ file, route, oldFile });
    return `${route}/${file.originalname}`;
  },
};

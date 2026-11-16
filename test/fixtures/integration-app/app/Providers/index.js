export const UploadProvider = {
  async upload(file, route) {
    return `${route}/${file.originalname}`;
  },
};

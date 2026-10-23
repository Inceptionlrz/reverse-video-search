// 路由表：路径模板编译为正则，支持 :param 与 * 通配。只做匹配，不写业务。
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      if (seg === '*') {
        keys.push('wildcard');
        return '(.*)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^/${source}/?$`), keys };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const m = String(method).toUpperCase();
    if (!METHODS.includes(m)) throw new Error(`不支持的 HTTP 方法: ${method}`);
    const { regex, keys } = compile(pattern);
    this.routes.push({ method: m, pattern, regex, keys, handler });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  put(pattern, handler) {
    return this.add('PUT', pattern, handler);
  }

  patch(pattern, handler) {
    return this.add('PATCH', pattern, handler);
  }

  del(pattern, handler) {
    return this.add('DELETE', pattern, handler);
  }

  match(method, pathname) {
    const m = String(method).toUpperCase();
    for (const route of this.routes) {
      if (route.method !== m) continue;
      const hit = route.regex.exec(pathname);
      if (!hit) continue;
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(hit[index + 1] || '');
      });
      return { route, params };
    }
    return null;
  }

  list() {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }
}

export function createRouter() {
  return new Router();
}

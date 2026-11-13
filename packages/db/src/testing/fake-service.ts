/**
 * A test double for a service `S` that implements only the methods a test needs.
 *
 * The methods given are type-checked against `S`: a name `S` lacks or a wrong signature fails to
 * compile. Calling any method not given throws an error naming it, so a test that reaches past its
 * fake fails with that name instead of "is not a function".
 *
 * Symbol keys and `then` read as undefined, as on a plain object, so the fake is never mistaken
 * for a promise and inspection or equality checks see nothing extra.
 */
export const fakeService = <S extends object>(methods: Partial<NoInfer<S>>): S =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the proxy answers every member methods lacks with a function that throws, so it stands in for all of S.
  new Proxy(methods, {
    get: (target, key, receiver) => {
      if (Reflect.has(target, key) || typeof key === "symbol" || key === "then") {
        return Reflect.get(target, key, receiver);
      }
      return () => {
        throw new Error(`fakeService: ${key} was called, but this test's fake does not provide it`);
      };
    },
  }) as S;

FROM nicolaka/netshoot@sha256:47b907d662d139d1e2f22bfe14f4efca1e3f1feed283572f47c970c780c03b61

RUN apk add --no-cache wireguard-tools dnsmasq
COPY gateway.py /usr/local/lib/sealant/gateway.py
ENTRYPOINT ["python3", "-I", "-B", "/usr/local/lib/sealant/gateway.py"]
CMD ["serve"]

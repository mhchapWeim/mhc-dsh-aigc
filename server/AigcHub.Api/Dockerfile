FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY AigcHub.Api.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
ENTRYPOINT ["dotnet", "AigcHub.Api.dll"]
